"""Reusable rubrics (Google Classroom parity).

A teacher builds a rubric once (a list of ``{criterion, description, maxPoints}``)
and attaches it to any assignment, which copies the criteria onto that coursework
(stored under ``coursework.attachments["rubric"]``) so grading can score against
it. Ported from v2 ``services/learner/rubric_service.py``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import AuthUser, get_current_user
from coursework import get_owned_coursework
from database import get_db
from membership import require_teacher_of
from models import Rubric

router = APIRouter(prefix="/api/lms", tags=["rubrics"])


class RubricCriterion(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    criterion: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    max_points: float = Field(alias="maxPoints", ge=0)


class CreateRubricRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    criteria: list[RubricCriterion] = Field(min_length=1)


class UpdateRubricRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    title: str | None = Field(default=None, max_length=200)
    criteria: list[RubricCriterion] | None = None


class AttachRubricRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    coursework_id: str = Field(alias="courseworkId")


def _criteria_dicts(criteria: list[RubricCriterion]) -> list[dict]:
    return [c.model_dump(by_alias=True) for c in criteria]


def serialize_rubric(r: Rubric) -> dict:
    criteria = r.criteria or []
    return {
        "id": r.id,
        "classroomId": r.classroom_id,
        "title": r.title,
        "criteria": criteria,
        "maxPoints": sum(float(c.get("maxPoints", 0) or 0) for c in criteria),
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def _get_owned_rubric(db: Session, user: AuthUser, rubric_id: str) -> Rubric:
    rubric = db.scalar(select(Rubric).where(Rubric.id == rubric_id))
    if not rubric or rubric.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rubric not found.")
    require_teacher_of(db, user, rubric.classroom_id)
    return rubric


@router.post("/classrooms/{classroom_id}/rubrics", status_code=status.HTTP_201_CREATED)
def create_rubric(
    classroom_id: str,
    body: CreateRubricRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom = require_teacher_of(db, user, classroom_id)
    rubric = Rubric(
        classroom_id=classroom_id,
        school_id=classroom.school_id,
        teacher_id=user.user_id,
        title=body.title,
        criteria=_criteria_dicts(body.criteria),
    )
    db.add(rubric)
    db.commit()
    db.refresh(rubric)
    return serialize_rubric(rubric)


@router.get("/classrooms/{classroom_id}/rubrics")
def list_rubrics(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    rubrics = list(
        db.scalars(
            select(Rubric)
            .where(Rubric.classroom_id == classroom_id)
            .order_by(Rubric.created_at.desc())
        ).all()
    )
    return {"rubrics": [serialize_rubric(r) for r in rubrics]}


@router.get("/rubrics/mine")
def list_my_rubrics(
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Sprint 4, P2 (T2.2): every rubric this teacher authored, across every
    classroom they teach — the read side of school-scoped reuse below.
    Without this, a teacher reusing a rubric in their other section had no
    way to find it short of navigating back to the classroom that owns it."""
    rubrics = list(
        db.scalars(
            select(Rubric)
            .where(Rubric.teacher_id == user.user_id, Rubric.school_id == user.school_id)
            .order_by(Rubric.created_at.desc())
        ).all()
    )
    return {"rubrics": [serialize_rubric(r) for r in rubrics]}


@router.patch("/rubrics/{rubric_id}")
def update_rubric(
    rubric_id: str,
    body: UpdateRubricRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rubric = _get_owned_rubric(db, user, rubric_id)
    if body.title is not None:
        rubric.title = body.title
    if body.criteria is not None:
        if not body.criteria:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A rubric needs at least one criterion.")
        rubric.criteria = _criteria_dicts(body.criteria)
    db.commit()
    db.refresh(rubric)
    return serialize_rubric(rubric)


@router.delete("/rubrics/{rubric_id}")
def delete_rubric(
    rubric_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rubric = _get_owned_rubric(db, user, rubric_id)
    db.delete(rubric)
    db.commit()
    return {"ok": True, "rubricId": rubric_id}


@router.post("/rubrics/{rubric_id}/attach")
def attach_rubric(
    rubric_id: str,
    body: AttachRubricRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Copy a rubric's criteria onto a coursework item (reuse). The assignment's
    grading UI then scores against ``rubricCriteria`` (its own field since
    Sprint 1, T2.3 — attachments is a plain link/file list now, matching
    Announcement's shape).

    Sprint 4, P2 (T2.2): relaxed from same-classroom to same-school. A
    teacher's "my other section of the same subject" is a different
    classroom by definition, so the original same-classroom check made
    reuse across sections impossible — directly against this sprint's
    theme. `_get_owned_rubric` above already requires the caller teach the
    rubric's *own* classroom, and `get_owned_coursework` requires they teach
    the target's — this only widens what the two classrooms are allowed to
    be relative to each other. What's copied is `rubric.criteria` (a plain
    JSON list), not a reference, so nothing here creates a cross-classroom
    foreign key."""
    rubric = _get_owned_rubric(db, user, rubric_id)
    coursework = get_owned_coursework(db, user, body.coursework_id)
    if coursework.school_id != rubric.school_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Rubric and coursework are in different schools.",
        )
    coursework.rubric_criteria = rubric.criteria
    db.commit()
    return {"courseworkId": coursework.id, "rubric": rubric.criteria}
