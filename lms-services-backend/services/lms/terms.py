"""Academic terms — Sprint 2, P1. A term (e.g. "2026-27") is school-scoped,
not classroom- or teacher-scoped: any teacher in the school can see and
assign one, the same way a school's academic calendar isn't owned by one
class. `Classroom.term_id` (models.py) is what actually filters class lists;
this module only manages the `Term` rows themselves.

At most one term per school may be `is_current`. Enforced here (not a
Postgres partial unique index) so the SQLite test path behaves the same way
the real database does.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from auth import AuthUser, require_student, require_teacher
from database import get_db
from models import Classroom, Term

router = APIRouter(prefix="/api/lms", tags=["terms"])


def _as_utc(value: datetime) -> datetime:
    # Same reasoning as stream.py/coursework.py/todo.py's _as_utc: SQLite
    # (tests) drops tzinfo on read-back even for a DateTime(timezone=True)
    # column; Postgres doesn't. Without this, comparing a freshly-parsed
    # (aware) Pydantic value against a DB-loaded (naive, under SQLite) one
    # raises TypeError.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class CreateTermRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    start_date: datetime = Field(alias="startDate")
    end_date: datetime = Field(alias="endDate")
    is_current: bool = Field(default=False, alias="isCurrent")

    @model_validator(mode="after")
    def _dates_ordered(self) -> "CreateTermRequest":
        if self.end_date <= self.start_date:
            raise ValueError("endDate must be after startDate.")
        return self


class UpdateTermRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    name: str | None = Field(default=None, max_length=120)
    start_date: datetime | None = Field(default=None, alias="startDate")
    end_date: datetime | None = Field(default=None, alias="endDate")
    is_current: bool | None = Field(default=None, alias="isCurrent")


def serialize_term(term: Term) -> dict:
    return {
        "id": term.id,
        "schoolId": term.school_id,
        "name": term.name,
        "startDate": term.start_date.isoformat(),
        "endDate": term.end_date.isoformat(),
        "isCurrent": term.is_current,
        "createdAt": term.created_at.isoformat() if term.created_at else None,
    }


def _get_school_term(db: Session, user: AuthUser, term_id: str) -> Term:
    term = db.scalar(select(Term).where(Term.id == term_id))
    if not term or term.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Term not found.")
    return term


def _clear_other_current_terms(db: Session, school_id: str, keep_id: str | None) -> None:
    others = db.scalars(
        select(Term).where(Term.school_id == school_id, Term.is_current.is_(True), Term.id != keep_id)
    )
    for other in others:
        other.is_current = False


@router.post("/terms", status_code=status.HTTP_201_CREATED)
def create_term(
    body: CreateTermRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    term = Term(
        school_id=user.school_id,
        name=body.name,
        start_date=body.start_date,
        end_date=body.end_date,
        is_current=body.is_current,
    )
    db.add(term)
    db.flush()
    if body.is_current:
        _clear_other_current_terms(db, user.school_id, term.id)
    db.commit()
    db.refresh(term)
    return serialize_term(term)


@router.get("/terms")
def list_terms(
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    terms = list(
        db.scalars(
            select(Term).where(Term.school_id == user.school_id).order_by(Term.start_date.desc())
        ).all()
    )
    return {"terms": [serialize_term(t) for t in terms]}


@router.get("/student/terms")
def list_terms_for_student(
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    """Sprint 3, P1: closes the gap Sprint 2 P1 left open —
    `list_student_classrooms` (classrooms.py) already accepts `term_id` for
    filtering, but a student had no way to read the term list itself to
    build that filter's own picker. Same rows as the teacher route, same
    school scope; the read is not teacher-privileged information."""
    terms = list(
        db.scalars(
            select(Term).where(Term.school_id == user.school_id).order_by(Term.start_date.desc())
        ).all()
    )
    return {"terms": [serialize_term(t) for t in terms]}


@router.patch("/terms/{term_id}")
def update_term(
    term_id: str,
    body: UpdateTermRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    term = _get_school_term(db, user, term_id)
    if body.name is not None:
        term.name = body.name
    if body.start_date is not None:
        term.start_date = body.start_date
    if body.end_date is not None:
        term.end_date = body.end_date
    if _as_utc(term.end_date) <= _as_utc(term.start_date):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="endDate must be after startDate.")
    if body.is_current is not None:
        term.is_current = body.is_current
        if body.is_current:
            _clear_other_current_terms(db, user.school_id, term.id)
    db.commit()
    db.refresh(term)
    return serialize_term(term)


@router.delete("/terms/{term_id}")
def delete_term(
    term_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    term = _get_school_term(db, user, term_id)
    # Explicit rather than relying on the FK's ondelete='SET NULL': that
    # constraint is real DB-level behavior under Postgres, but the SQLite
    # engine this service's tests run against (database.py) never enables
    # `PRAGMA foreign_keys`, so it wouldn't fire there. Doing it here in
    # application code makes the two environments behave identically
    # instead of only one of them being correct.
    db.execute(update(Classroom).where(Classroom.term_id == term.id).values(term_id=None))
    db.delete(term)
    db.commit()
    return {"ok": True, "termId": term_id}
