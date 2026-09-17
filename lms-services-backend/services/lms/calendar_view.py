"""Calendar — coursework due-date aggregation across a user's classes, plus
(Sprint 2, P4) one-off classroom events (``CalendarEvent``) that exist
independently of ``due_at``.

The aggregate endpoint was read-only, reusing coursework ``due_at``; it now
also merges in events. Daily/weekly/monthly views are just the
[start, end] range the caller passes. Ported from v2
``services/learner/calendar_service.py``.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

import classrooms as cr
from auth import AuthUser, get_current_user
from coursework import visible_coursework_filter
from database import get_db
from membership import require_member, require_teacher_of
from models import CalendarEvent, Coursework, CourseworkStatus
from timeutil import as_utc

router = APIRouter(prefix="/api/lms", tags=["calendar"])

_NON_GRADEABLE = {"material"}


# ── Calendar events (Sprint 2, P4) ──────────────────────────────────────────

class CreateCalendarEventRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=240)
    description: str | None = None
    starts_at: datetime = Field(alias="startsAt")
    ends_at: datetime | None = Field(default=None, alias="endsAt")

    @model_validator(mode="after")
    def _ends_after_starts(self) -> "CreateCalendarEventRequest":
        if self.ends_at is not None and self.ends_at < self.starts_at:
            raise ValueError("endsAt cannot be before startsAt.")
        return self


class UpdateCalendarEventRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    title: str | None = Field(default=None, max_length=240)
    description: str | None = None
    starts_at: datetime | None = Field(default=None, alias="startsAt")
    ends_at: datetime | None = Field(default=None, alias="endsAt")


def serialize_calendar_event(e: CalendarEvent) -> dict:
    return {
        "id": e.id,
        "classroomId": e.classroom_id,
        "createdBy": e.created_by,
        "title": e.title,
        "description": e.description,
        "startsAt": e.starts_at.isoformat(),
        "endsAt": e.ends_at.isoformat() if e.ends_at else None,
        "createdAt": e.created_at.isoformat() if e.created_at else None,
    }


def _get_owned_event(db: Session, user: AuthUser, event_id: str) -> CalendarEvent:
    event = db.scalar(select(CalendarEvent).where(CalendarEvent.id == event_id))
    if not event or event.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    require_teacher_of(db, user, event.classroom_id)
    return event


@router.post("/classrooms/{classroom_id}/calendar-events", status_code=status.HTTP_201_CREATED)
def create_calendar_event(
    classroom_id: str,
    body: CreateCalendarEventRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom = require_teacher_of(db, user, classroom_id)
    event = CalendarEvent(
        classroom_id=classroom.id,
        school_id=user.school_id,
        created_by=user.user_id,
        title=body.title,
        description=body.description,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return serialize_calendar_event(event)


@router.get("/classrooms/{classroom_id}/calendar-events")
def list_calendar_events(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_member(db, user, classroom_id)
    events = list(
        db.scalars(
            select(CalendarEvent)
            .where(CalendarEvent.classroom_id == classroom_id)
            .order_by(CalendarEvent.starts_at.asc())
        ).all()
    )
    return {"events": [serialize_calendar_event(e) for e in events]}


@router.patch("/calendar-events/{event_id}")
def update_calendar_event(
    event_id: str,
    body: UpdateCalendarEventRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    event = _get_owned_event(db, user, event_id)
    if body.title is not None:
        event.title = body.title
    if body.description is not None:
        event.description = body.description
    if body.starts_at is not None:
        event.starts_at = body.starts_at
    if body.ends_at is not None:
        event.ends_at = body.ends_at
    if event.ends_at is not None and event.ends_at < event.starts_at:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="endsAt cannot be before startsAt.")
    db.commit()
    db.refresh(event)
    return serialize_calendar_event(event)


@router.delete("/calendar-events/{event_id}")
def delete_calendar_event(
    event_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    event = _get_owned_event(db, user, event_id)
    db.delete(event)
    db.commit()
    return {"ok": True, "eventId": event_id}


def _accessible_classroom_ids(db: Session, user: AuthUser) -> dict[str, str]:
    """Map of classroom_id -> name for classes the user teaches or is enrolled in."""
    if user.role == "teacher":
        classrooms = cr.list_teacher_classrooms(db, user, only_archived=False)
    elif user.role == "student":
        classrooms = cr.list_student_classrooms(db, user)
    else:
        classrooms = []
    return {c.id: c.name for c in classrooms}


@router.get("/calendar")
def calendar(
    start: Annotated[datetime | None, Query()] = None,
    end: Annotated[datetime | None, Query()] = None,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    # A client-supplied start/end with no UTC offset (e.g. "2026-09-
    # 01T00:00:00") parses as a naive datetime, while the default below is
    # aware. This mixing is a correctness risk against Postgres specifically
    # — psycopg binds a naive datetime to a `timestamptz` column using the
    # session's timezone setting, not UTC, so a naive bound and an aware
    # bound one hour apart on a non-UTC session could select a different set
    # of rows near the boundary. (Verified this is NOT reproducible against
    # the SQLite test engine: SQLAlchemy's SQLite DateTime(timezone=True)
    # type decorator strips tzinfo symmetrically from both stored values and
    # bound parameters before comparing, so naive and aware bounds already
    # coincide there — this fix has no test-suite-visible effect and is
    # verified by direct inspection of the bind behavior, not a passing
    # test.) Every other datetime comparison against this column elsewhere in
    # the service assumes UTC for a naive value (the same convention the
    # frontend's parseApiDate uses), so a client-supplied bound gets the same
    # treatment here rather than being left to whatever
    # `datetime.fromisoformat` happened to parse.
    start = as_utc(start) if start else now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = as_utc(end) if end else (start + timedelta(days=30))

    names = _accessible_classroom_ids(db, user)
    by_date: dict[str, list[dict]] = {}
    if names:
        coursework_query = select(Coursework).where(
            Coursework.classroom_id.in_(list(names.keys())),
            Coursework.status == CourseworkStatus.PUBLISHED.value,
            Coursework.due_at.is_not(None),
            Coursework.due_at >= start,
            Coursework.due_at <= end,
        )
        if user.role == "student":
            # Sprint 3, C9: a teacher sees every due date in their own
            # classes regardless of targeting (they authored it); a student
            # sees only what's actually assigned to them.
            coursework_query = coursework_query.where(visible_coursework_filter(user.user_id))
        items = db.scalars(coursework_query).all()
        for cw in items:
            if cw.type in _NON_GRADEABLE:
                continue
            day = cw.due_at.date().isoformat()
            by_date.setdefault(day, []).append(
                {
                    "kind": "coursework",
                    "courseworkId": cw.id,
                    "classroomId": cw.classroom_id,
                    "classroomName": names.get(cw.classroom_id),
                    "title": cw.title,
                    "type": cw.type,
                    "dueAt": cw.due_at.isoformat(),
                    "maxPoints": float(cw.max_points) if cw.max_points is not None else None,
                }
            )

        # Sprint 2, P4: one-off events (exams, field trips) merged in
        # alongside coursework due-dates — same [start, end] window, same
        # by-day grouping, distinguished by "kind".
        events = db.scalars(
            select(CalendarEvent).where(
                CalendarEvent.classroom_id.in_(list(names.keys())),
                CalendarEvent.starts_at >= start,
                CalendarEvent.starts_at <= end,
            )
        ).all()
        for ev in events:
            day = ev.starts_at.date().isoformat()
            by_date.setdefault(day, []).append(
                {
                    "kind": "event",
                    "eventId": ev.id,
                    "classroomId": ev.classroom_id,
                    "classroomName": names.get(ev.classroom_id),
                    "title": ev.title,
                    "description": ev.description,
                    "dueAt": ev.starts_at.isoformat(),
                    "endsAt": ev.ends_at.isoformat() if ev.ends_at else None,
                }
            )

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": [
            {"date": day, "events": sorted(evs, key=lambda e: e["dueAt"])}
            for day, evs in sorted(by_date.items())
        ],
        "total": sum(len(v) for v in by_date.values()),
    }
