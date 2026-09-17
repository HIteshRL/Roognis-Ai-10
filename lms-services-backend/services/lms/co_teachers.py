"""Co-teachers — a classroom's owning teacher may add/remove other teachers
who can then act as a teacher of that class (grade, post, manage coursework)
without owning it. Backed by ``Enrollment.role == "co_teacher"`` — the same
table Sprint 1's roadmap already anticipated (models.py's EnrollmentRole enum
had a CO_TEACHER value, unused until this feature).

Adding a co-teacher takes an email, not a user id — LMS has no user
directory, so the id is resolved via a synchronous internal call to the Auth
Service (``clients.lookup_teacher_by_email``).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import clients
from auth import AuthUser, get_current_user
from classrooms import (
    add_co_teacher,
    list_enrollments,
    remove_co_teacher,
    serialize_co_teacher,
)
from config import Settings, get_settings
from database import get_db
from membership import require_teacher_of
from models import EnrollmentRole, EnrollmentStatus

router = APIRouter(prefix="/api/lms", tags=["co-teachers"])


class AddCoTeacherRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    email: str = Field(min_length=3, max_length=255)


@router.get("/classrooms/{classroom_id}/co-teachers")
def list_co_teachers(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    co_teachers = list_enrollments(
        db,
        classroom_id,
        status_filter=EnrollmentStatus.ACTIVE.value,
        role_filter=EnrollmentRole.CO_TEACHER.value,
    )
    return {"coTeachers": [serialize_co_teacher(e) for e in co_teachers]}


@router.post("/classrooms/{classroom_id}/co-teachers", status_code=status.HTTP_201_CREATED)
def add_co_teacher_route(
    classroom_id: str,
    body: AddCoTeacherRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    classroom = require_teacher_of(db, user, classroom_id, allow_co_teacher=False)

    email = body.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A valid email is required.")

    try:
        found = clients.lookup_teacher_by_email(settings, email, user.school_id)
    except clients.AuthServiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not verify that email right now. Try again shortly.",
        ) from exc
    if not found:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No teacher found with that email in your school.",
        )

    enrollment = add_co_teacher(db, classroom, found["userId"], found.get("name"))
    db.commit()
    db.refresh(enrollment)
    return serialize_co_teacher(enrollment)


@router.delete("/classrooms/{classroom_id}/co-teachers/{user_id}")
def remove_co_teacher_route(
    classroom_id: str,
    user_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    remove_co_teacher(db, classroom_id, user_id)
    db.commit()
    return {"ok": True, "userId": user_id}
