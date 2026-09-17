"""Stream — classroom announcements (Google Classroom parity).

Teachers always post; students may post only when the class's
``settings["stream_permission"] == "post_and_comment"``. Students see published
posts only; teachers additionally see their own drafts and scheduled posts.
Comments on a post live in discussions.py (``Comment.announcement_id``).

Ported from v2 ``services/learner/stream_service.py`` into the foundation's sync
direct-SQLAlchemy style; publishing a post notifies every enrolled student.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

import notifications as notify
import notification_types as ntype
from auth import AuthUser, get_current_user
from classrooms import list_enrollments
from database import get_db
from lifecycle import publish_due_scheduled
from membership import require_member
from models import Announcement, Comment, EnrollmentRole
from schemas import Attachment

router = APIRouter(prefix="/api/lms", tags=["stream"])

_DEFAULT_PERMISSION = "comment_only"
_STATUSES = ("draft", "scheduled", "published")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Request bodies ───────────────────────────────────────────────────────────
# `Attachment` moved to schemas.py (Sprint 1, T2.3) — Coursework now uses the
# same shape, so it's imported from there rather than defined here.

class CreateAnnouncementRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    body: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=240)
    attachments: list[Attachment] = Field(default_factory=list)
    status: str = Field(default="published")
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    is_pinned: bool = Field(default=False, alias="isPinned")


class UpdateAnnouncementRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    body: str | None = None
    title: str | None = Field(default=None, max_length=240)
    attachments: list[Attachment] | None = None
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    is_pinned: bool | None = Field(default=None, alias="isPinned")


class PinRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    pinned: bool = True


# ── Serializer ───────────────────────────────────────────────────────────────

def _comment_count(db: Session, announcement_id: str) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Comment)
        .where(Comment.announcement_id == announcement_id, Comment.is_deleted.is_(False))
    ) or 0


def comment_count_bulk(db: Session, announcement_ids: list[str]) -> dict[str, int]:
    """Batched form of _comment_count — one GROUP BY for the whole page of
    announcements instead of one query per row. Used by list_announcements,
    which allows up to 100 per page."""
    if not announcement_ids:
        return {}
    rows = db.execute(
        select(Comment.announcement_id, func.count())
        .where(Comment.announcement_id.in_(announcement_ids), Comment.is_deleted.is_(False))
        .group_by(Comment.announcement_id)
    ).all()
    counts = dict(rows)
    return {aid: counts.get(aid, 0) for aid in announcement_ids}


def serialize_announcement(db: Session, a: Announcement, *, comment_count: int | None = None) -> dict:
    """`comment_count` lets list_announcements pass in a precomputed value
    (see comment_count_bulk); every other call site serializes one row at a
    time and falls back to the per-row query, which is the right cost there."""
    return {
        "id": a.id,
        "classroomId": a.classroom_id,
        "authorId": a.author_id,
        "authorName": a.author_name or "Teacher",
        "title": a.title,
        "body": a.body,
        "attachments": a.attachments or [],
        "status": a.status,
        "scheduledFor": a.scheduled_for.isoformat() if a.scheduled_for else None,
        "isPinned": a.is_pinned,
        "publishedAt": a.published_at.isoformat() if a.published_at else None,
        "commentCount": comment_count if comment_count is not None else _comment_count(db, a.id),
        "createdAt": a.created_at.isoformat() if a.created_at else None,
        "updatedAt": a.updated_at.isoformat() if a.updated_at else None,
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_editable(db: Session, user: AuthUser, announcement_id: str) -> tuple[Announcement, bool]:
    """Returns the post and whether the caller is a teacher of its classroom.

    The flag is part of the return because editability and *pinning* are not
    the same permission: this admits the author, who may be a student in a
    `post_and_comment` class, while pinning is a teacher-only moderation
    action. Callers that can change `is_pinned` need to know which one they
    are talking to."""
    announcement = db.scalar(
        select(Announcement).where(
            Announcement.id == announcement_id,
            Announcement.is_deleted.is_(False),
        )
    )
    if not announcement or announcement.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found.")
    _classroom, is_teacher = require_member(db, user, announcement.classroom_id)
    if announcement.author_id != user.user_id and not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author or a teacher can modify this post.",
        )
    return announcement, is_teacher


def _notify_students(db: Session, classroom, announcement: Announcement) -> None:
    student_ids = [
        e.student_id
        for e in list_enrollments(
            db, classroom.id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
        )
        if e.student_id != announcement.author_id
    ]
    notify.emit_many(
        db,
        user_ids=student_ids,
        school_id=classroom.school_id,
        type=ntype.NEW_ANNOUNCEMENT,
        title=f"New post in {classroom.name}",
        body=(announcement.title or announcement.body)[:200],
        data={"classroomId": classroom.id, "announcementId": announcement.id},
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/classrooms/{classroom_id}/announcements", status_code=status.HTTP_201_CREATED)
def create_announcement(
    classroom_id: str,
    body: CreateAnnouncementRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom, is_teacher = require_member(db, user, classroom_id)
    permission = (classroom.settings or {}).get("stream_permission", _DEFAULT_PERMISSION)
    if not is_teacher and permission != "post_and_comment":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only teachers can post to the stream in this class.",
        )

    post_status = body.status if body.status in _STATUSES else "published"
    scheduled_for = None
    published_at = None
    if post_status == "scheduled":
        if not body.scheduled_for:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A scheduled post needs a scheduledFor time.",
            )
        scheduled_for = body.scheduled_for
    elif post_status == "published":
        published_at = _now()

    announcement = Announcement(
        classroom_id=classroom_id,
        school_id=user.school_id,
        author_id=user.user_id,
        author_name=user.name or None,
        title=body.title,
        body=body.body,
        attachments=[a.model_dump() for a in body.attachments],
        status=post_status,
        scheduled_for=scheduled_for,
        is_pinned=body.is_pinned if is_teacher else False,
        published_at=published_at,
    )
    db.add(announcement)
    db.flush()
    if post_status == "published":
        _notify_students(db, classroom, announcement)
    db.commit()
    db.refresh(announcement)
    return serialize_announcement(db, announcement)


def _sort_key(a: Announcement) -> tuple:
    # Mirrors the SQL ORDER BY below, used to re-sort in Python after a lazy
    # publish flip — the SQL ordering ran before the flip, using the
    # pre-flip published_at (still null for a row that just became due).
    return (
        not a.is_pinned,
        -(a.published_at.timestamp() if a.published_at else float("-inf")),
        -a.created_at.timestamp(),
    )


def _publish_due_scheduled(db: Session, classroom, items: list[Announcement], now: datetime) -> None:
    """Lazily flip any `scheduled` post whose `scheduled_for` has passed —
    no scheduler process exists or is warranted; this is the read-time
    equivalent of `publish_announcement`'s manual publish.

    The claim-and-notify race is handled by lifecycle.py, shared with
    coursework.py's copy: a plain attribute-assignment-then-flush let two
    concurrent readers of the same due-scheduled post both flip it and both
    notify the whole roster, since the read and the write weren't atomic."""
    publish_due_scheduled(
        db,
        Announcement,
        scheduled_value="scheduled",
        published_value="published",
        items=items,
        now=now,
        notify_one=lambda a: _notify_students(db, classroom, a),
    )


@router.get("/classrooms/{classroom_id}/announcements")
def list_announcements(
    classroom_id: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom, is_teacher = require_member(db, user, classroom_id)
    now = _now()
    query = select(Announcement).where(
        Announcement.classroom_id == classroom_id,
        Announcement.is_deleted.is_(False),
    )
    if not is_teacher:
        query = query.where(
            or_(
                Announcement.status == "published",
                and_(Announcement.status == "scheduled", Announcement.scheduled_for <= now),
            )
        )
    query = query.order_by(
        Announcement.is_pinned.desc(),
        Announcement.published_at.desc().nullslast(),
        Announcement.created_at.desc(),
    ).limit(limit)
    items = list(db.scalars(query).all())

    _publish_due_scheduled(db, classroom, items, now)
    items.sort(key=_sort_key)

    counts_by_id = comment_count_bulk(db, [a.id for a in items])
    return {
        "announcements": [
            serialize_announcement(db, a, comment_count=counts_by_id[a.id]) for a in items
        ]
    }


@router.patch("/announcements/{announcement_id}")
def update_announcement(
    announcement_id: str,
    body: UpdateAnnouncementRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    announcement, is_teacher = _get_editable(db, user, announcement_id)
    if body.body is not None:
        announcement.body = body.body
    if body.title is not None:
        announcement.title = body.title
    if body.attachments is not None:
        announcement.attachments = [a.model_dump() for a in body.attachments]
    if body.scheduled_for is not None:
        announcement.scheduled_for = body.scheduled_for
    if body.is_pinned is not None:
        # Pinning is a teacher-only moderation action — enforced on create
        # (is_pinned if is_teacher else False) and by the dedicated pin
        # endpoint, but not here, which let a student author of a
        # post_and_comment class PATCH themselves to the top of the stream
        # permanently (list_announcements orders is_pinned.desc() first).
        if not is_teacher:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a teacher can pin posts.",
            )
        announcement.is_pinned = body.is_pinned
    db.commit()
    db.refresh(announcement)
    return serialize_announcement(db, announcement)


@router.post("/announcements/{announcement_id}/publish")
def publish_announcement(
    announcement_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    announcement, _is_teacher = _get_editable(db, user, announcement_id)
    if announcement.status != "published":
        classroom, _ = require_member(db, user, announcement.classroom_id)
        announcement.status = "published"
        announcement.scheduled_for = None
        announcement.published_at = _now()
        db.flush()
        _notify_students(db, classroom, announcement)
        db.commit()
        db.refresh(announcement)
    return serialize_announcement(db, announcement)


@router.post("/announcements/{announcement_id}/pin")
def pin_announcement(
    announcement_id: str,
    body: PinRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    announcement = db.scalar(
        select(Announcement).where(
            Announcement.id == announcement_id,
            Announcement.is_deleted.is_(False),
        )
    )
    if not announcement or announcement.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post not found.")
    # Pinning is a teacher-only moderation action.
    _classroom, is_teacher = require_member(db, user, announcement.classroom_id)
    if not is_teacher:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a teacher can pin posts.")
    announcement.is_pinned = body.pinned
    db.commit()
    db.refresh(announcement)
    return serialize_announcement(db, announcement)


@router.delete("/announcements/{announcement_id}")
def delete_announcement(
    announcement_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    announcement, _is_teacher = _get_editable(db, user, announcement_id)
    announcement.is_deleted = True
    db.commit()
    return {"ok": True, "announcementId": announcement_id}
