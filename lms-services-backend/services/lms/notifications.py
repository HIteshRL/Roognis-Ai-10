"""In-app notification center + emission helpers (ported from v2 learner
notification_service).

Emission is *fail-open*: a failed notification must never break the request that
triggered it (posting an announcement, replying to a comment, inviting a
guardian). Reading and marking are ordinary authenticated endpoints. Emission
helpers only ``flush`` — the calling route owns the ``commit``.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import AuthUser, get_current_user
from database import get_db
from models import Notification

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/lms", tags=["notifications"])


# ── Emission (fail-open, flush-only) ─────────────────────────────────────────

def emit(
    db: Session,
    *,
    user_id: str,
    school_id: str,
    type: str,
    title: str,
    body: str = "",
    data: dict | None = None,
    dedupe_key: str | None = None,
) -> None:
    """`dedupe_key`, when supplied, is enforced by a real unique constraint on
    (user_id, dedupe_key) — not just a caller-side check-then-act SELECT — so
    two callers racing to emit "the same" notification for a user can't both
    succeed. A collision is the expected, benign case (someone else's request
    already recorded it) and is logged quietly; anything else stays at
    warning, same as before.

    The SAVEPOINT is what actually makes either case fail-open. Catching the
    exception around a bare db.flush() did not: a failed flush leaves the
    session in a "needs rollback" state, so the *caller's* subsequent
    db.commit() raised PendingRollbackError and the triggering request 500'd
    anyway — the module's stated invariant held only when the flush never
    failed, which is precisely the case this guard exists for. begin_nested
    confines the rollback to this insert and leaves the outer transaction
    usable.
    """
    try:
        with db.begin_nested():
            db.add(
                Notification(
                    user_id=user_id,
                    school_id=school_id,
                    type=type,
                    title=title,
                    body=body,
                    data=data or {},
                    dedupe_key=dedupe_key,
                )
            )
    except IntegrityError as exc:
        if dedupe_key is not None:
            logger.debug("notification dedupe hit (%s, %s): %s", type, dedupe_key, exc)
        else:
            logger.warning("notification emit failed (%s): %s", type, exc)
    except Exception as exc:  # noqa: BLE001 — notifications must never break the trigger
        logger.warning("notification emit failed (%s): %s", type, exc)


def emit_many(
    db: Session,
    *,
    user_ids: Iterable[str],
    school_id: str,
    type: str,
    title: str,
    body: str = "",
    data: dict | None = None,
) -> None:
    for uid in user_ids:
        emit(db, user_id=uid, school_id=school_id, type=type, title=title, body=body, data=data)


def emit_batch(db: Session, items: Iterable[dict]) -> None:
    """Sprint 4, P3: like `emit_many`, but every insert shares **one**
    SAVEPOINT instead of one per item. Built for a caller (bulk grading)
    that already knows every row is well-formed and wants the batch's
    fail-open unit to be "the whole batch", not "one row of it" — a batch
    of 100 notifications was previously 100 separate `begin_nested()`
    round-trips, the same shape `emit`'s own docstring already fixed for a
    single call.

    Each item is the same kwargs `emit()` takes:
    `{user_id, school_id, type, title, body?, data?, dedupe_key?}`.

    Trade-off, deliberate: one failure (e.g. an unexpected constraint hit)
    rolls back every insert in the batch, not just the offending row —
    unlike `emit`/`emit_many`, where each row gets its own savepoint and a
    collision on one never touches the rest. That is the wrong shape for
    something like the due-date sweep, which relies on per-row dedupe
    collisions being routine and independent. It is the right shape here:
    the grades this batch is notifying about are already flushed by the
    caller before this runs, so a notification-only failure never touches
    already-committed grade state — only the notifications themselves are
    at risk, and losing all of them together (then relying on the
    student's next `/student/todo` read, or a manual retry) is an
    acceptable, rare-case cost for one savepoint instead of N.
    """
    try:
        with db.begin_nested():
            for item in items:
                db.add(
                    Notification(
                        user_id=item["user_id"],
                        school_id=item["school_id"],
                        type=item["type"],
                        title=item["title"],
                        body=item.get("body", ""),
                        data=item.get("data") or {},
                        dedupe_key=item.get("dedupe_key"),
                    )
                )
    except IntegrityError as exc:
        logger.warning("notification emit_batch failed (constraint): %s", exc)
    except Exception as exc:  # noqa: BLE001 — notifications must never break the trigger
        logger.warning("notification emit_batch failed: %s", exc)


# ── Serializer ───────────────────────────────────────────────────────────────

def serialize_notification(n: Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "data": n.data or {},
        "isRead": n.is_read,
        "createdAt": n.created_at.isoformat() if n.created_at else None,
    }


# ── Reading (fail-closed) ────────────────────────────────────────────────────

@router.get("/notifications")
def list_notifications(
    unread_only: Annotated[bool, Query(alias="unreadOnly")] = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = select(Notification).where(
        Notification.user_id == user.user_id, Notification.school_id == user.school_id
    )
    if unread_only:
        query = query.where(Notification.is_read.is_(False))
    items = list(db.scalars(query.order_by(Notification.created_at.desc()).limit(limit)).all())
    unread = db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user.user_id,
            Notification.school_id == user.school_id,
            Notification.is_read.is_(False),
        )
    ) or 0
    return {
        "notifications": [serialize_notification(n) for n in items],
        "unreadCount": unread,
    }


@router.get("/notifications/unread-count")
def unread_count(
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    count = db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user.user_id,
            Notification.school_id == user.school_id,
            Notification.is_read.is_(False),
        )
    ) or 0
    return {"unreadCount": count}


@router.post("/notifications/{notification_id}/read")
def mark_read(
    notification_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = db.scalar(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user.user_id,
            Notification.school_id == user.school_id,
        )
    )
    if notification and not notification.is_read:
        notification.is_read = True
        db.commit()
    return {"ok": True, "notificationId": notification_id}


@router.post("/notifications/read-all")
def mark_all_read(
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    db.execute(
        update(Notification)
        .where(
            Notification.user_id == user.user_id,
            Notification.school_id == user.school_id,
            Notification.is_read.is_(False),
        )
        .values(is_read=True)
    )
    db.commit()
    return {"ok": True}


# Retention campaigns retry this endpoint; each notification is durably deduplicated.
from datetime import datetime, timezone
from pydantic import BaseModel, Field
from auth import require_internal_token

class InternalNotification(BaseModel):
    userId: str = Field(min_length=1, max_length=36)
    schoolId: str = Field(min_length=1, max_length=36)
    type: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(default="", max_length=4000)
    data: dict = Field(default_factory=dict)
    dedupeKey: str = Field(min_length=1, max_length=240)
    expiresAt: datetime | None = None

class InternalNotificationBatch(BaseModel):
    notifications: list[InternalNotification] = Field(min_length=1, max_length=200)

@router.post("/internal/notifications/batch", dependencies=[Depends(require_internal_token)])
def internal_batch(body: InternalNotificationBatch, db: Session = Depends(get_db)):
    accepted=0
    for item in body.notifications:
        if item.expiresAt and item.expiresAt.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc): continue
        existing=db.scalar(select(Notification.id).where(Notification.user_id==item.userId,Notification.dedupe_key==item.dedupeKey))
        if existing: continue
        try:
            with db.begin_nested():
                db.add(Notification(user_id=item.userId,school_id=item.schoolId,type=item.type,title=item.title,body=item.body,data=item.data,dedupe_key=item.dedupeKey))
                db.flush()
            accepted+=1
        except IntegrityError:
            existing=db.scalar(select(Notification.id).where(Notification.user_id==item.userId,Notification.dedupe_key==item.dedupeKey))
            if not existing: raise
    db.commit()
    return {"accepted":accepted}
