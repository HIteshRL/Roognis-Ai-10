"""Classroom groups — Sprint 3, T2.4. A teacher-defined convenience for
targeting coursework at a subset of students. Owner/co-teacher CRUD;
students never read this — a group is an authoring tool, not something a
student needs to see. Membership changes have no effect on anything already
published (decision D9): `POST /coursework/{id}/publish` resolves a
`groupId` to student ids once, at publish time.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import AuthUser, get_current_user
from database import get_db
from membership import require_teacher_of
from models import ClassroomGroup, ClassroomGroupMember

router = APIRouter(prefix="/api/lms", tags=["groups"])


class CreateGroupRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=160)
    student_ids: list[str] = Field(default_factory=list, alias="studentIds")


class UpdateGroupRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    name: str | None = Field(default=None, max_length=160)
    # None = leave membership unchanged; an explicit (possibly empty) list
    # replaces it entirely — same "None means untouched" convention
    # UpdateCourseworkRequest already uses for its optional fields.
    student_ids: list[str] | None = Field(default=None, alias="studentIds")


def serialize_group(g: ClassroomGroup) -> dict:
    return {
        "id": g.id,
        "classroomId": g.classroom_id,
        "name": g.name,
        "studentIds": [m.student_id for m in g.members],
        "createdAt": g.created_at.isoformat() if g.created_at else None,
    }


def _get_owned_group(db: Session, user: AuthUser, group_id: str) -> ClassroomGroup:
    group = db.scalar(select(ClassroomGroup).where(ClassroomGroup.id == group_id))
    if not group or group.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found.")
    require_teacher_of(db, user, group.classroom_id)
    return group


def _set_members(db: Session, group: ClassroomGroup, student_ids: list[str]) -> None:
    db.query(ClassroomGroupMember).filter(ClassroomGroupMember.group_id == group.id).delete()
    for student_id in dict.fromkeys(student_ids):  # de-dupe, preserve order
        db.add(ClassroomGroupMember(group_id=group.id, student_id=student_id))


@router.post("/classrooms/{classroom_id}/groups", status_code=status.HTTP_201_CREATED)
def create_group(
    classroom_id: str,
    body: CreateGroupRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom = require_teacher_of(db, user, classroom_id)
    group = ClassroomGroup(classroom_id=classroom_id, school_id=classroom.school_id, name=body.name)
    db.add(group)
    db.flush()
    _set_members(db, group, body.student_ids)
    db.commit()
    db.refresh(group)
    return serialize_group(group)


@router.get("/classrooms/{classroom_id}/groups")
def list_groups(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    groups = list(
        db.scalars(
            select(ClassroomGroup)
            .where(ClassroomGroup.classroom_id == classroom_id)
            .order_by(ClassroomGroup.name.asc())
        ).all()
    )
    return {"groups": [serialize_group(g) for g in groups]}


@router.patch("/groups/{group_id}")
def update_group(
    group_id: str,
    body: UpdateGroupRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    group = _get_owned_group(db, user, group_id)
    if body.name is not None:
        group.name = body.name
    if body.student_ids is not None:
        _set_members(db, group, body.student_ids)
    db.commit()
    db.refresh(group)
    return serialize_group(group)


@router.delete("/groups/{group_id}")
def delete_group(
    group_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    group = _get_owned_group(db, user, group_id)
    db.delete(group)
    db.commit()
    return {"ok": True, "groupId": group_id}
