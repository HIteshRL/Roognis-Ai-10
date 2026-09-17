"""Shared classroom authorization helpers.

Sprint 3, S3.0.1: the single gate for "does this user teach this classroom".
Before this, `classrooms.get_owned_classroom` and this module's own
`require_teacher_of` did nearly the same check with two real differences that
had drifted apart (`HANDOFF.md` names this as the root cause of the Sprint 2
co-teacher permission bugs): `get_owned_classroom` never checked `user.role`,
relying on the fact that `Classroom.teacher_id` and
`Enrollment.role == CO_TEACHER` rows are only ever set for teacher accounts;
and only `get_owned_classroom` could restrict a route to the owning teacher,
skipping co-teachers, via `allow_co_teacher=False` (used by destructive
routes: delete, archive toggle, join-code regenerate, enrollment
approve/reject, chapter/coursework delete, `remove_student`). This module
keeps both properties in one function rather than reconciling two.

A *member* of a classroom is the owning teacher, an active co-teacher, or an
actively-enrolled student. `require_member` mirrors `require_teacher_of` but
admits either role, which the social features (stream, comments) need.
Everything stays school-scoped and never reaches across the microservice
boundary into auth_db.
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import AuthUser
from classrooms import is_active_co_teacher, is_enrolled
from models import Classroom


def get_visible_classroom(db: Session, user: AuthUser, classroom_id: str) -> Classroom:
    """Fetch a live classroom in the user's school or raise 404."""
    classroom = db.scalar(
        select(Classroom).where(
            Classroom.id == classroom_id,
            Classroom.is_deleted.is_(False),
        )
    )
    if not classroom or classroom.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Classroom not found.")
    return classroom


def is_teacher_of(db: Session, user: AuthUser, classroom: Classroom) -> bool:
    if user.role != "teacher":
        return False
    if classroom.teacher_id == user.user_id:
        return True
    return is_active_co_teacher(db, classroom.id, user.user_id)


def require_member(db: Session, user: AuthUser, classroom_id: str) -> tuple[Classroom, bool]:
    """Return ``(classroom, is_teacher)`` for a member, else raise 403.

    A member is the owning teacher, an active co-teacher, or an active student.
    """
    classroom = get_visible_classroom(db, user, classroom_id)
    if is_teacher_of(db, user, classroom):
        return classroom, True
    if user.role == "student" and is_enrolled(db, classroom_id, user.user_id):
        return classroom, False
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You are not a member of this class.",
    )


def require_teacher_of(
    db: Session, user: AuthUser, classroom_id: str, *, allow_co_teacher: bool = True
) -> Classroom:
    """Return the classroom if ``user`` owns it, or (when ``allow_co_teacher``)
    co-teaches it, else raise. ``allow_co_teacher=False`` restricts a route to
    the owning teacher only — see the module docstring for which routes need
    that and why."""
    classroom = get_visible_classroom(db, user, classroom_id)
    if allow_co_teacher:
        if is_teacher_of(db, user, classroom):
            return classroom
    elif user.role == "teacher" and classroom.teacher_id == user.user_id:
        return classroom
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You do not teach this classroom.",
    )
