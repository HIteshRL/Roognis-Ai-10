"""Classwork topics — Google Classroom's classwork organization.

Lightweight teacher-owned groupings that coursework is filed under
(``Coursework.topic_id``). Students can read topics to see the grouped Classwork
tab; only teachers create/rename/reorder/delete. Deleting a topic leaves its
coursework in place (``topic_id`` is SET NULL).

Ported from v2 ``services/learner/topic_service.py``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import AuthUser, get_current_user
from coursework import get_owned_coursework
from database import get_db
from membership import require_member, require_teacher_of
from models import Topic

router = APIRouter(prefix="/api/lms", tags=["topics"])


class CreateTopicRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=160)


class UpdateTopicRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    name: str | None = Field(default=None, max_length=160)
    order_index: int | None = Field(default=None, alias="orderIndex", ge=0)


class AssignTopicRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    topic_id: str | None = Field(default=None, alias="topicId")


def serialize_topic(t: Topic) -> dict:
    return {
        "id": t.id,
        "classroomId": t.classroom_id,
        "name": t.name,
        "orderIndex": t.order_index,
        "createdAt": t.created_at.isoformat() if t.created_at else None,
    }


def _get_owned_topic(db: Session, user: AuthUser, topic_id: str) -> Topic:
    topic = db.scalar(select(Topic).where(Topic.id == topic_id))
    if not topic or topic.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Topic not found.")
    require_teacher_of(db, user, topic.classroom_id)
    return topic


@router.post("/classrooms/{classroom_id}/topics", status_code=status.HTTP_201_CREATED)
def create_topic(
    classroom_id: str,
    body: CreateTopicRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom = require_teacher_of(db, user, classroom_id)
    next_order = db.scalar(
        select(func.max(Topic.order_index)).where(Topic.classroom_id == classroom_id)
    )
    topic = Topic(
        classroom_id=classroom_id,
        school_id=classroom.school_id,
        name=body.name,
        order_index=(next_order + 1) if next_order is not None else 0,
    )
    db.add(topic)
    db.commit()
    db.refresh(topic)
    return serialize_topic(topic)


@router.get("/classrooms/{classroom_id}/topics")
def list_topics(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_member(db, user, classroom_id)
    topics = list(
        db.scalars(
            select(Topic)
            .where(Topic.classroom_id == classroom_id)
            .order_by(Topic.order_index.asc(), Topic.created_at.asc())
        ).all()
    )
    return {"topics": [serialize_topic(t) for t in topics]}


@router.patch("/topics/{topic_id}")
def update_topic(
    topic_id: str,
    body: UpdateTopicRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    topic = _get_owned_topic(db, user, topic_id)
    if body.name is not None:
        topic.name = body.name
    if body.order_index is not None:
        topic.order_index = body.order_index
    db.commit()
    db.refresh(topic)
    return serialize_topic(topic)


@router.delete("/topics/{topic_id}")
def delete_topic(
    topic_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    topic = _get_owned_topic(db, user, topic_id)
    db.delete(topic)
    db.commit()
    return {"ok": True, "topicId": topic_id}


@router.post("/coursework/{coursework_id}/topic")
def assign_coursework_topic(
    coursework_id: str,
    body: AssignTopicRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """File a coursework item under a topic (or clear it with ``topicId: null``)."""
    coursework = get_owned_coursework(db, user, coursework_id)
    if body.topic_id:
        topic = db.scalar(select(Topic).where(Topic.id == body.topic_id))
        if not topic or topic.classroom_id != coursework.classroom_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Topic is not in this classroom.",
            )
        coursework.topic_id = topic.id
    else:
        coursework.topic_id = None
    db.commit()
    return {"courseworkId": coursework_id, "topicId": coursework.topic_id}
