"""Roster operations at scale — Sprint 3, P1: bulk archive, a
teacher-scoped student lookup across classes, and bulk roster add/remove.
Additive-only lane: no schema change, so no Alembic revision.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import classrooms as cr
from auth import AuthUser, require_teacher
from database import get_db
from membership import require_teacher_of

router = APIRouter(prefix="/api/lms", tags=["roster-ops"])


class BulkArchiveRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    classroom_ids: list[str] = Field(default_factory=list, alias="classroomIds")
    # An alternative selector to naming every id — "archive last year" in
    # one request. If both are given, classroomIds ∪ (classes in termId).
    term_id: str | None = Field(default=None, alias="termId")
    archived: bool = True


class BulkRosterAddItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    student_id: str = Field(alias="studentId", min_length=1, max_length=36)
    student_name: str | None = Field(default=None, alias="studentName", max_length=160)


class BulkRosterRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    add: list[BulkRosterAddItem] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


@router.post("/classrooms/bulk-archive")
def bulk_archive_classrooms(
    body: BulkArchiveRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    """Archive (or unarchive) many classrooms in one request. Owner-only,
    matching the single-classroom archive route — administrative, changes
    visibility for everyone. A classroom the caller doesn't own is
    skipped and named in the response rather than failing the whole
    batch, so one stale id in a long list doesn't block the rest."""
    classroom_ids = set(body.classroom_ids)
    if body.term_id:
        classroom_ids.update(
            c.id for c in cr.list_teacher_classrooms(db, user, term_id=body.term_id)
        )
        classroom_ids.update(
            c.id
            for c in cr.list_teacher_classrooms(db, user, only_archived=True, term_id=body.term_id)
        )

    archived_ids: list[str] = []
    skipped_ids: list[str] = []
    for classroom_id in classroom_ids:
        try:
            classroom = require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
        except HTTPException:
            skipped_ids.append(classroom_id)
            continue
        cr.set_archived(db, classroom, body.archived)
        archived_ids.append(classroom_id)
    db.commit()
    return {"archived": archived_ids, "skipped": skipped_ids}


@router.get("/students/{student_id}")
def get_student_classes(
    student_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    rows = cr.list_student_classes_for_teacher(db, user, student_id)
    return {
        "studentId": student_id,
        "classrooms": [
            {
                "classroomId": classroom.id,
                "name": classroom.name,
                "subject": classroom.subject,
                "isArchived": classroom.is_archived,
                "joinedAt": enrollment.joined_at.isoformat() if enrollment.joined_at else None,
            }
            for classroom, enrollment in rows
        ],
    }


@router.post("/classrooms/{classroom_id}/students/bulk")
def bulk_update_roster(
    classroom_id: str,
    body: BulkRosterRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Adding is a co-teacher's day-to-day duty (matches the single-student
    # invite route); removing stays owner-only (matches the single-student
    # delete route's stated blast-radius rationale) — checked again below,
    # specifically, only if the request actually asks to remove anyone.
    classroom = require_teacher_of(db, user, classroom_id)
    if body.remove:
        require_teacher_of(db, user, classroom_id, allow_co_teacher=False)

    added: list[str] = []
    add_skipped: list[str] = []
    for item in body.add:
        try:
            cr.add_student_by_email(db, classroom, item.student_id, item.student_name)
        except HTTPException:
            add_skipped.append(item.student_id)
            continue
        added.append(item.student_id)

    removed: list[str] = []
    remove_skipped: list[str] = []
    for student_id in body.remove:
        try:
            cr.remove_student(db, classroom_id, student_id)
        except HTTPException:
            remove_skipped.append(student_id)
            continue
        removed.append(student_id)

    db.commit()
    return {
        "added": added,
        "addSkipped": add_skipped,
        "removed": removed,
        "removeSkipped": remove_skipped,
    }
