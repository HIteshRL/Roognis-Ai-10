"""Student email invitations — Sprint 2, P1.

Genuinely new work, not a reuse of the guardian invite pattern:
`Guardian.token` (models.py) is generated on invite but its accept-by-token
flow is intentionally omitted (guardians.py) — guardian linkage lives in
auth_db instead. That pattern doesn't fit here.

Scope decision (recorded in docs/SPRINT2_PLAN.md as D6): this resolves the
invite synchronously against an *existing* student account, the same way
co_teachers.py resolves a co-teacher invite — via a synchronous internal
call to the Auth Service (`clients.lookup_student_by_email`) — and enrolls
immediately. There is no pending-invitation-with-token entity and no email
is sent: no email-sending infrastructure exists anywhere in this codebase,
and building one is a materially larger feature than "invite a student who
already has an account," which is what K-12 deployments actually need (the
school provisions accounts; this replaces "share the join code" with
"look the student up by email" for a teacher who already knows who they
want). If a student has no account yet, the teacher is told to use the
join code instead — same shape as co_teachers.py's "no teacher found"
error.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import clients
from auth import AuthUser, get_current_user
from classrooms import add_student_by_email, serialize_enrollment
from config import Settings, get_settings
from database import get_db
from membership import require_teacher_of

router = APIRouter(prefix="/api/lms", tags=["student-invitations"])


class InviteStudentRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    email: str = Field(min_length=3, max_length=255)


@router.post("/classrooms/{classroom_id}/students/invite", status_code=status.HTTP_201_CREATED)
def invite_student_route(
    classroom_id: str,
    body: InviteStudentRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    classroom = require_teacher_of(db, user, classroom_id)

    email = body.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A valid email is required.")

    try:
        found = clients.lookup_student_by_email(settings, email, user.school_id)
    except clients.AuthServiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not verify that email right now. Try again shortly.",
        ) from exc
    if not found:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No student found with that email in your school. Share the join code instead.",
        )

    enrollment = add_student_by_email(db, classroom, found["userId"], found.get("name"))
    db.commit()
    db.refresh(enrollment)
    return serialize_enrollment(enrollment)
