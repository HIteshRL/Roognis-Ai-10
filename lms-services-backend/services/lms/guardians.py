"""Guardians — teacher-managed guardian roster + read-only guardian summaries.

Two sides, mapped onto TW2's identity model:

* **Teacher** invites/removes a student's guardians. A teacher may only manage
  guardians for a student enrolled in a class they own.
* **Guardian** (a ``parent`` role user) sees a read-only progress digest for each
  of their linked students, and can redeem an invite code to *become* linked.
  The actual authorization link is owned by the Auth Service
  (``auth_db.parentStudent``, which is what populates a parent JWT's
  ``studentIds`` at login) — the LMS never writes it directly.

Ported/adapted from v2 ``services/learner/guardian_service.py``. Previously
this module's own docstring recorded "the email-token accept flow is
intentionally omitted: linkage already lives in auth_db" — true, but nothing
ever *created* that linkage either, so a teacher inviting a guardian had zero
effect on what a parent could see. This is now a real, shareable
redeemable-code flow (``invite_guardian`` generates a code,
``redeem_guardian_code`` consumes one), mirroring the existing classroom
join-code pattern (``classrooms.py::unique_join_code`` /
``models.generate_join_code``) rather than an email-send — there is no
email-sending infrastructure anywhere in this codebase.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

import clients
from auth import AuthUser, get_current_user
from config import Settings, get_settings
from database import get_db
from models import Classroom, Enrollment, EnrollmentRole, EnrollmentStatus, Guardian, generate_guardian_code
from todo import student_progress_facts

router = APIRouter(prefix="/api/lms", tags=["guardians"])

# How long a generated guardian code stays redeemable. No expiry precedent
# exists elsewhere in this codebase to copy (a classroom join code never
# expires — it's long-lived and reusable, a materially different shape from
# a single-student, one-time-use guardian code), so this is a fresh judgment
# call: long enough that a guardian who doesn't check their messages daily
# still has time, short enough that a stale, unredeemed code isn't a
# standing way into a student's data indefinitely.
GUARDIAN_CODE_TTL_DAYS = 14

# Mirrors classrooms.py's _JOIN_CODE_MAX_ATTEMPTS — retries a fresh random
# code this many times on a collision before giving up and returning one
# unchecked (astronomically unlikely to matter at this code length, but the
# DB's own unique index on `token` is the real backstop either way).
_GUARDIAN_CODE_MAX_ATTEMPTS = 6


def require_parent(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role != "parent":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user


def require_teacher(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role != "teacher":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user


class InviteGuardianRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    guardian_email: str = Field(alias="guardianEmail", min_length=3, max_length=255)


class RedeemGuardianCodeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    code: str = Field(min_length=4, max_length=16)


def unique_guardian_code(db: Session) -> str:
    """Mirrors `classrooms.py::unique_join_code` exactly — retry on collision,
    fall back to one final unchecked generation (the DB's unique index on
    `token` is the real backstop, same as `join_code`'s)."""
    for _ in range(_GUARDIAN_CODE_MAX_ATTEMPTS):
        code = generate_guardian_code()
        exists = db.scalar(select(Guardian.id).where(Guardian.token == code))
        if not exists:
            return code
    return generate_guardian_code()


def _code_is_expired(guardian: Guardian) -> bool:
    if not guardian.code_expires_at:
        return True
    # SQLite (the pytest suite's engine) hands back a naive datetime for a
    # DateTime(timezone=True) column; Postgres hands back an aware one that
    # is always UTC (we only ever write UTC here) — the same
    # `.replace(tzinfo=timezone.utc)` idiom `notifications.py` already uses
    # for this exact cross-engine gap.
    return guardian.code_expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)


def serialize_guardian(g: Guardian) -> dict:
    out = {
        "id": g.id,
        "studentId": g.student_id,
        "guardianEmail": g.guardian_email,
        "guardianUserId": g.guardian_user_id,
        "status": g.status,
        "createdAt": g.created_at.isoformat() if g.created_at else None,
    }
    # The code is only meaningful — and only shown — while the invite is
    # still redeemable. A `removed` or already-`active` row's old code is
    # spent (or was invalidated), and showing it back would read as
    # something still shareable when it structurally can't be redeemed.
    if g.status == "pending":
        out["code"] = g.token
        out["codeExpiresAt"] = g.code_expires_at.isoformat() if g.code_expires_at else None
        out["codeExpired"] = _code_is_expired(g)
    return out


def _teacher_teaches_student(db: Session, teacher: AuthUser, student_id: str) -> Classroom | None:
    """A classroom the caller owns, or is an active co-teacher of. Guardians
    are tied to students a co-teacher already grades, posts to, and sees on
    the roster and gradebook — there is no narrower boundary to draw here
    than the one every other day-to-day teaching action already uses.

    This previously matched `Classroom.teacher_id` only, with no co-teacher
    consideration at all — unlike `remove_student`'s owner-only carve-out
    (`main.py`), which states its rationale (kicking a student out is
    high-impact enough to stay owner-only), this one had none: it simply
    predates co-teachers and was never revisited when that feature shipped."""
    co_teacher_classroom_ids = select(Enrollment.classroom_id).where(
        Enrollment.student_id == teacher.user_id,
        Enrollment.status == EnrollmentStatus.ACTIVE.value,
        Enrollment.role == EnrollmentRole.CO_TEACHER.value,
    )
    return db.scalar(
        select(Classroom)
        .join(Enrollment, Enrollment.classroom_id == Classroom.id)
        .where(
            Enrollment.student_id == student_id,
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            or_(
                Classroom.teacher_id == teacher.user_id,
                Classroom.id.in_(co_teacher_classroom_ids),
            ),
            Classroom.school_id == teacher.school_id,
            Classroom.is_deleted.is_(False),
        )
    )


# ── Teacher: guardian roster ─────────────────────────────────────────────────

@router.post("/students/{student_id}/guardians", status_code=status.HTTP_201_CREATED)
def invite_guardian(
    student_id: str,
    body: InviteGuardianRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    classroom = _teacher_teaches_student(db, user, student_id)
    if not classroom:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not teach this student.",
        )
    email = str(body.guardian_email).strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A valid guardian email is required.")
    existing = db.scalar(
        select(Guardian).where(
            Guardian.student_id == student_id,
            Guardian.guardian_email == email,
            Guardian.status != "removed",
        )
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That guardian is already invited.")

    # Denormalize the student's display name from an active enrollment.
    enrollment = db.scalar(
        select(Enrollment).where(
            Enrollment.student_id == student_id,
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
        )
    )
    guardian = Guardian(
        student_id=student_id,
        school_id=user.school_id,
        student_name=enrollment.student_name if enrollment else None,
        guardian_email=email,
        status="pending",
        token=unique_guardian_code(db),
        code_expires_at=datetime.now(timezone.utc) + timedelta(days=GUARDIAN_CODE_TTL_DAYS),
        invited_by=user.user_id,
    )
    db.add(guardian)
    db.commit()
    db.refresh(guardian)
    return serialize_guardian(guardian)


@router.get("/students/{student_id}/guardians")
def list_student_guardians(
    student_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    if not _teacher_teaches_student(db, user, student_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not teach this student.")
    guardians = list(
        db.scalars(
            select(Guardian).where(
                Guardian.student_id == student_id,
                Guardian.status != "removed",
            )
        ).all()
    )
    return {"guardians": [serialize_guardian(g) for g in guardians]}


@router.post("/guardians/{guardian_id}/regenerate-code")
def regenerate_guardian_code(
    guardian_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    """Sibling of `classrooms.py::regenerate_join_code`, for a code that
    expired (or was lost) before the guardian redeemed it. Only meaningful
    for a still-`pending` row — an `active` link doesn't need a code
    anymore, and re-issuing one would look like it could re-open something
    that's already linked."""
    guardian = db.scalar(select(Guardian).where(Guardian.id == guardian_id))
    if not guardian or guardian.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guardian link not found.")
    if not _teacher_teaches_student(db, user, guardian.student_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not teach this student.")
    if guardian.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This guardian is already linked.")

    guardian.token = unique_guardian_code(db)
    guardian.code_expires_at = datetime.now(timezone.utc) + timedelta(days=GUARDIAN_CODE_TTL_DAYS)
    db.commit()
    db.refresh(guardian)
    return serialize_guardian(guardian)


@router.delete("/guardians/{guardian_id}")
def remove_guardian(
    guardian_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    guardian = db.scalar(select(Guardian).where(Guardian.id == guardian_id))
    if not guardian or guardian.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guardian link not found.")
    if not _teacher_teaches_student(db, user, guardian.student_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not teach this student.")
    db.delete(guardian)
    db.commit()
    return {"ok": True, "guardianId": guardian_id}


# ── Guardian (parent role): redeem + read-only summaries ────────────────────

@router.post("/guardian/redeem")
def redeem_guardian_code(
    body: RedeemGuardianCodeRequest,
    user: AuthUser = Depends(require_parent),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """A logged-in parent redeems a code a teacher shared with them directly
    (text, printed slip, WhatsApp — whatever channel; this codebase has no
    email-sending infrastructure, so the code itself is the artifact that
    travels, the same way a classroom join code does).

    Two things must both happen, or neither should stick:
      1. This LMS's own `Guardian` row flips `pending` -> `active`.
      2. The Auth Service's `auth_db.parentStudent` row is upserted — that
         table, not anything in `lms_db`, is what actually authorizes a
         parent's reads (it's what populates JWT `studentIds` at login, and
         what `linked_student_ids()` below checks live).

    Order matters: the Auth Service call happens first, and this function's
    own row is only mutated and committed after it succeeds. If step 2
    raises, nothing here has been written yet, so a retry (or a fresh code)
    starts from a clean, still-`pending` state — never a half-linked one
    where the LMS thinks a guardian is active but the Auth Service disagrees.
    """
    code = body.code.strip().upper()
    guardian = db.scalar(select(Guardian).where(Guardian.token == code))
    # 404, not 403/410, when the code doesn't exist *or* belongs to another
    # school — same "never confirm a resource exists elsewhere" convention
    # `classrooms.py::join_by_code` uses for the analogous classroom lookup.
    if not guardian or guardian.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid guardian code.")
    if guardian.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This code has already been used.")
    if _code_is_expired(guardian):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="This code has expired. Ask the teacher for a new one.",
        )

    try:
        clients.link_parent_student(settings, user.user_id, guardian.student_id, user.school_id)
    except clients.AuthServiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not complete the link right now. Try again shortly.",
        ) from exc

    guardian.status = "active"
    guardian.guardian_user_id = user.user_id
    db.commit()
    db.refresh(guardian)
    return serialize_guardian(guardian)

@router.get("/guardian/students")
def guardian_students(
    user: AuthUser = Depends(require_parent),
    db: Session = Depends(get_db),
):
    """The parent's linked students (from the JWT), enriched with a display name
    from any active enrollment in this school."""
    out = []
    for student_id in linked_student_ids(user):
        enrollment = db.scalar(
            select(Enrollment).where(
                Enrollment.student_id == student_id,
                Enrollment.school_id == user.school_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
            )
        )
        out.append(
            {
                "studentId": student_id,
                "studentName": enrollment.student_name if enrollment else None,
            }
        )
    return {"students": out}


@router.get("/guardian/students/{student_id}/summary")
def guardian_summary(
    student_id: str,
    user: AuthUser = Depends(require_parent),
    db: Session = Depends(get_db),
):
    if student_id not in linked_student_ids(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a guardian of this student.",
        )

    # Sprint 1, T4.3: shares its computation with GET /student/todo rather
    # than a second hand-copied query. `upcoming` here recovers the
    # original *unbounded* future window (todo.py's own response caps
    # "upcoming" at 7 days and drops `later` — a parent still wants
    # everything ahead, not just this week's).
    facts = student_progress_facts(db, student_id, user.school_id)
    return {
        "studentId": student_id,
        "upcoming": facts["dueToday"] + facts["upcoming"] + facts["later"],
        "missing": facts["overdue"],
        "recentGrades": facts["recentlyGraded"],
        "generatedAt": facts["generatedAt"],
    }


def linked_student_ids(user):
    import json
    from urllib.request import Request, urlopen
    from urllib.parse import urlencode
    from urllib.error import URLError
    from config import get_settings
    settings=get_settings()
    if not settings.auth_service_url or not settings.internal_service_token:
        raise HTTPException(503, "Guardian links could not be verified.")
    req=Request(settings.auth_service_url.rstrip("/")+f"/api/auth/internal/parents/{user.user_id}/students?"+urlencode({"schoolId":user.school_id}),
        headers={"X-Internal-Service-Token":settings.internal_service_token})
    try:
        with urlopen(req,timeout=5) as response: return json.load(response)["studentIds"]
    except (URLError, ValueError, KeyError, OSError):
        raise HTTPException(503, "Guardian links could not be verified.")
