"""Classroom discussions — comments on the stream or a coursework item, threaded
replies, emoji reactions and @mentions (with notifications).

Ported from v2 ``services/learner/discussion_service.py``. Both teachers and
enrolled students participate; membership is checked per call. A comment targets
a stream post (``announcementId``), a coursework item (``courseworkId``), or is a
reply to another comment (``parentId``).

Sprint 2, P3 adds a fourth target: ``submissionId``, always private — see
``Comment``'s docstring in models.py for the visibility invariant.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import notifications as notify
import notification_types as ntype
from auth import AuthUser, get_current_user
from classrooms import list_enrollments
from database import get_db
from membership import require_member
from models import (
    Classroom,
    Comment,
    CommentReaction,
    Coursework,
    EnrollmentRole,
    EnrollmentStatus,
    Submission,
)

router = APIRouter(prefix="/api/lms", tags=["discussions"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Request bodies ───────────────────────────────────────────────────────────

class CreateCommentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
    body: str = Field(min_length=1, max_length=5000)
    coursework_id: str | None = Field(default=None, alias="courseworkId")
    announcement_id: str | None = Field(default=None, alias="announcementId")
    submission_id: str | None = Field(default=None, alias="submissionId")
    parent_id: str | None = Field(default=None, alias="parentId")
    # Bounded because each entry becomes a notification INSERT. Unbounded, one
    # request could issue tens of thousands of inserts while holding one of
    # only five pooled connections. 25 is well past any real classroom mention.
    mentions: list[str] = Field(default_factory=list, max_length=25)


class UpdateCommentRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    body: str = Field(min_length=1, max_length=5000)


class ReactRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    emoji: str = Field(min_length=1, max_length=16)


# ── Serializer ───────────────────────────────────────────────────────────────

def _reaction_summary(db: Session, comment_id: str) -> dict[str, int]:
    rows = db.execute(
        select(CommentReaction.emoji, func.count())
        .where(CommentReaction.comment_id == comment_id)
        .group_by(CommentReaction.emoji)
    ).all()
    return {row[0]: row[1] for row in rows}


def _reply_count(db: Session, comment_id: str) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Comment)
        .where(Comment.parent_id == comment_id, Comment.is_deleted.is_(False))
    ) or 0


def reaction_summary_bulk(db: Session, comment_ids: list[str]) -> dict[str, dict[str, int]]:
    """Batched form of _reaction_summary — one GROUP BY for the whole page of
    comments instead of one query per comment. Used by list_comments, where a
    page of up to 100 comments previously cost up to 100 extra queries just
    for reactions (and another 100 for reply counts, below)."""
    if not comment_ids:
        return {}
    rows = db.execute(
        select(CommentReaction.comment_id, CommentReaction.emoji, func.count())
        .where(CommentReaction.comment_id.in_(comment_ids))
        .group_by(CommentReaction.comment_id, CommentReaction.emoji)
    ).all()
    result: dict[str, dict[str, int]] = {cid: {} for cid in comment_ids}
    for comment_id, emoji, count in rows:
        result[comment_id][emoji] = count
    return result


def reply_count_bulk(db: Session, comment_ids: list[str]) -> dict[str, int]:
    """Batched form of _reply_count — see reaction_summary_bulk."""
    if not comment_ids:
        return {}
    rows = db.execute(
        select(Comment.parent_id, func.count())
        .where(Comment.parent_id.in_(comment_ids), Comment.is_deleted.is_(False))
        .group_by(Comment.parent_id)
    ).all()
    counts = dict(rows)
    return {cid: counts.get(cid, 0) for cid in comment_ids}


def serialize_comment(
    db: Session,
    c: Comment,
    *,
    reactions: dict[str, int] | None = None,
    reply_count: int | None = None,
) -> dict:
    """`reactions`/`reply_count` let a caller that already batched them
    (list_comments) pass the precomputed values in; every other call site
    (one comment at a time — create/react/unreact) leaves them None and this
    falls back to the per-comment query, which is the right cost for one row."""
    return {
        "id": c.id,
        "classroomId": c.classroom_id,
        "courseworkId": c.coursework_id,
        "announcementId": c.announcement_id,
        "submissionId": c.submission_id,
        "visibility": c.visibility,
        "parentId": c.parent_id,
        "authorId": c.author_id,
        "authorName": c.author_name,
        "body": c.body,
        "mentions": c.mentions or [],
        "reactions": reactions if reactions is not None else _reaction_summary(db, c.id),
        "replyCount": reply_count if reply_count is not None else _reply_count(db, c.id),
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


def _get_comment(db: Session, comment_id: str, user: AuthUser) -> Comment:
    comment = db.scalar(
        select(Comment).where(Comment.id == comment_id, Comment.is_deleted.is_(False))
    )
    if not comment or comment.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found.")
    return comment


def _resolve_mention_targets(
    db: Session, classroom: Classroom, mentions: list[str], author_id: str
) -> list[str]:
    """Intersect client-supplied @mention ids with the classroom's actual
    membership (owner, co-teachers, active students), minus the author.

    Order is preserved so a client sees notifications in the order it listed
    them, and duplicates are collapsed so mentioning someone twice in one
    comment does not notify them twice."""
    if not mentions:
        return []
    allowed = {classroom.teacher_id}
    allowed.update(
        e.student_id
        for e in list_enrollments(db, classroom.id, status_filter=EnrollmentStatus.ACTIVE.value)
    )
    allowed.discard(author_id)

    seen: set[str] = set()
    targets: list[str] = []
    for mention in mentions:
        if mention in allowed and mention not in seen:
            seen.add(mention)
            targets.append(mention)
    return targets


def _assert_can_view_private(db: Session, user: AuthUser, comment: Comment, is_teacher: bool) -> None:
    """A private comment is visible only to a teacher of the classroom or
    the submission's own student — checked wherever a comment is reached
    by id (reactions), not just where it's listed."""
    if comment.visibility != "private" or is_teacher:
        return
    submission = db.scalar(select(Submission).where(Submission.id == comment.submission_id))
    if not submission or submission.student_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You cannot access this comment.")


def _authorize_submission_comment(
    db: Session, user: AuthUser, submission_id: str, classroom_id: str, is_teacher: bool
) -> Submission:
    submission = db.scalar(select(Submission).where(Submission.id == submission_id))
    if not submission or submission.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found.")
    coursework = db.scalar(select(Coursework).where(Coursework.id == submission.coursework_id))
    if not coursework or coursework.classroom_id != classroom_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Submission is not in this classroom.")
    if not is_teacher and submission.student_id != user.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot comment on another student's submission.",
        )
    return submission


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/classrooms/{classroom_id}/comments", status_code=status.HTTP_201_CREATED)
def create_comment(
    classroom_id: str,
    body: CreateCommentRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom, is_teacher = require_member(db, user, classroom_id)

    parent = None
    if body.parent_id:
        parent = db.scalar(
            select(Comment).where(Comment.id == body.parent_id, Comment.is_deleted.is_(False))
        )
        if not parent or parent.classroom_id != classroom_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent comment not found.")
        # A reply always inherits its parent's scope/visibility (models.py's
        # Comment docstring) — the client's own submissionId/courseworkId/
        # announcementId are ignored once parentId is given.
        _assert_can_view_private(db, user, parent, is_teacher)

    submission_id = parent.submission_id if parent else body.submission_id
    coursework_id = parent.coursework_id if parent else body.coursework_id
    announcement_id = parent.announcement_id if parent else body.announcement_id
    visibility = "class"
    submission = None

    if submission_id:
        if announcement_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A submission comment cannot also target an announcement.",
            )
        submission = _authorize_submission_comment(db, user, submission_id, classroom_id, is_teacher)
        coursework_id = submission.coursework_id
        visibility = "private"
    elif announcement_id and not is_teacher:
        # Stream-comment moderation: a "teachers_only" class blocks student
        # comments on announcements. Only applies to public stream comments —
        # a private submission comment is never subject to it.
        permission = (classroom.settings or {}).get("stream_permission", "comment_only")
        if permission == "teachers_only":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only teachers can comment on the stream in this class.",
            )

    comment = Comment(
        classroom_id=classroom_id,
        school_id=user.school_id,
        author_id=user.user_id,
        author_name=user.name or None,
        body=body.body,
        coursework_id=coursework_id,
        announcement_id=announcement_id,
        submission_id=submission_id,
        visibility=visibility,
        parent_id=parent.id if parent else None,
        mentions=[m for m in body.mentions if isinstance(m, str)],
    )
    db.add(comment)
    db.flush()

    # Only the first message in a private thread gets this notification —
    # a reply already triggers the existing "reply to parent author" notify
    # below, and firing both here would double-notify the same event.
    if visibility == "private" and not parent:
        if is_teacher:
            notify.emit(
                db,
                user_id=submission.student_id,
                school_id=user.school_id,
                type=ntype.PRIVATE_COMMENT,
                title=f"{user.name or 'Your teacher'} left you a private comment",
                body=comment.body[:200],
                data={"classroomId": classroom_id, "submissionId": submission_id, "commentId": comment.id},
            )
        else:
            teacher_ids = {classroom.teacher_id}
            teacher_ids.update(
                e.student_id
                for e in list_enrollments(
                    db, classroom_id, status_filter=EnrollmentStatus.ACTIVE.value, role_filter=EnrollmentRole.CO_TEACHER.value
                )
            )
            notify.emit_many(
                db,
                user_ids=sorted(teacher_ids),
                school_id=user.school_id,
                type=ntype.PRIVATE_COMMENT,
                title=f"{user.name or 'A student'} left a private comment",
                body=comment.body[:200],
                data={"classroomId": classroom_id, "submissionId": submission_id, "commentId": comment.id},
            )

    # @mention notifications — restricted to people actually in this
    # classroom. `mentions` is client-supplied and was previously passed
    # straight through to emit_many, which made any comment box a
    # send-a-notification-to-any-user-in-the-school primitive: an attacker
    # could put 200 characters of their own text in front of anyone in the
    # school who was not in the class, including staff. Membership is
    # re-derived here rather than trusted from the request.
    mention_targets = _resolve_mention_targets(db, classroom, comment.mentions, user.user_id)
    if mention_targets:
        notify.emit_many(
            db,
            user_ids=mention_targets,
            school_id=user.school_id,
            type=ntype.MENTION,
            title=f"{user.name or 'Someone'} mentioned you",
            body=comment.body[:200],
            data={"classroomId": classroom_id, "commentId": comment.id},
        )
    # Reply notification to the parent author.
    if parent and parent.author_id != user.user_id:
        notify.emit(
            db,
            user_id=parent.author_id,
            school_id=user.school_id,
            type=ntype.REPLY,
            title=f"{user.name or 'Someone'} replied to your comment",
            body=comment.body[:200],
            data={"classroomId": classroom_id, "commentId": comment.id},
        )
    db.commit()
    db.refresh(comment)
    return serialize_comment(db, comment)


@router.get("/classrooms/{classroom_id}/comments")
def list_comments(
    classroom_id: str,
    coursework_id: Annotated[str | None, Query(alias="courseworkId")] = None,
    announcement_id: Annotated[str | None, Query(alias="announcementId")] = None,
    submission_id: Annotated[str | None, Query(alias="submissionId")] = None,
    parent_id: Annotated[str | None, Query(alias="parentId")] = None,
    search: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _classroom, is_teacher = require_member(db, user, classroom_id)
    query = select(Comment).where(
        Comment.classroom_id == classroom_id,
        Comment.is_deleted.is_(False),
    )
    # Top-level thread scoping: when no parent is requested, only return roots.
    if parent_id is not None:
        query = query.where(Comment.parent_id == parent_id)
    else:
        query = query.where(Comment.parent_id.is_(None))

    if submission_id is not None:
        # A private thread: only that submission's own student or a teacher
        # of this classroom may list it.
        submission = db.scalar(select(Submission).where(Submission.id == submission_id))
        if not submission or submission.school_id != user.school_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found.")
        if not is_teacher and submission.student_id != user.user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You cannot view comments on another student's submission.",
            )
        query = query.where(Comment.submission_id == submission_id)
    else:
        # Never let a private submission comment leak into a general
        # coursework/announcement/all-threads listing.
        query = query.where(Comment.visibility != "private")
        if coursework_id is not None:
            query = query.where(Comment.coursework_id == coursework_id)
        if announcement_id is not None:
            query = query.where(Comment.announcement_id == announcement_id)
    if search:
        query = query.where(Comment.body.ilike(f"%{search}%"))
    items = list(db.scalars(query.order_by(Comment.created_at.asc()).limit(limit)).all())
    ids = [c.id for c in items]
    reactions_by_id = reaction_summary_bulk(db, ids)
    reply_counts_by_id = reply_count_bulk(db, ids)
    return {
        "comments": [
            serialize_comment(db, c, reactions=reactions_by_id[c.id], reply_count=reply_counts_by_id[c.id])
            for c in items
        ]
    }


@router.patch("/comments/{comment_id}")
def update_comment(
    comment_id: str,
    body: UpdateCommentRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    comment = _get_comment(db, comment_id, user)
    if comment.author_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only edit your own comments.")
    comment.body = body.body
    db.commit()
    db.refresh(comment)
    return serialize_comment(db, comment)


@router.delete("/comments/{comment_id}")
def delete_comment(
    comment_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    comment = _get_comment(db, comment_id, user)
    _classroom, is_teacher = require_member(db, user, comment.classroom_id)
    if comment.author_id != user.user_id and not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the author or a teacher can delete a comment.",
        )
    comment.is_deleted = True
    comment.deleted_at = _now()
    db.commit()
    return {"ok": True, "commentId": comment_id}


@router.post("/comments/{comment_id}/reactions")
def react(
    comment_id: str,
    body: ReactRequest,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    comment = _get_comment(db, comment_id, user)
    _classroom, is_teacher = require_member(db, user, comment.classroom_id)
    _assert_can_view_private(db, user, comment, is_teacher)
    existing = db.scalar(
        select(CommentReaction).where(
            CommentReaction.comment_id == comment_id,
            CommentReaction.user_id == user.user_id,
            CommentReaction.emoji == body.emoji,
        )
    )
    if not existing:
        db.add(CommentReaction(comment_id=comment_id, user_id=user.user_id, emoji=body.emoji))
        db.commit()
    return {"commentId": comment_id, "reactions": _reaction_summary(db, comment_id)}


@router.delete("/comments/{comment_id}/reactions/{emoji}")
def unreact(
    comment_id: str,
    emoji: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    comment = _get_comment(db, comment_id, user)
    _classroom, is_teacher = require_member(db, user, comment.classroom_id)
    _assert_can_view_private(db, user, comment, is_teacher)
    existing = db.scalar(
        select(CommentReaction).where(
            CommentReaction.comment_id == comment_id,
            CommentReaction.user_id == user.user_id,
            CommentReaction.emoji == emoji,
        )
    )
    if existing:
        db.delete(existing)
        db.commit()
    return {"commentId": comment_id, "reactions": _reaction_summary(db, comment_id)}
