"""Shared lazy-publish-on-read logic for scheduled `Announcement` and
`Coursework` rows (Sprint 1, T1.3 / T2.1). Both models share the same three
columns (`status`, `scheduled_for`, `published_at`) and the same
no-scheduler-process, exactly-once pattern, so the transition itself lives
here rather than as two copies (it was two copies, `coursework.py` and
`stream.py`, each carrying a comment pointing at the other) — a correctness
fix to the race below would otherwise have to be applied twice, correctly,
in lockstep.
"""
from __future__ import annotations

from datetime import datetime
from typing import Callable, TypeVar

from sqlalchemy import update
from sqlalchemy.orm import Session

from timeutil import as_utc

T = TypeVar("T")


def publish_due_scheduled(
    db: Session,
    model: type[T],
    *,
    scheduled_value: str,
    published_value: str,
    items: list[T],
    now: datetime,
    notify_one: Callable[[T], None],
) -> None:
    """`items` is a candidate list the caller already loaded (it may include
    rows that are already published, which are skipped below). For each
    candidate whose `scheduled_for` has passed, claims it with a conditional
    `UPDATE ... WHERE id = :id AND status = 'scheduled'` rather than a plain
    Python attribute assignment.

    That distinction is the actual fix: the previous version set the
    attributes directly and unconditionally flushed, on the assumption that
    the `status != published` filter already applied in the SELECT made the
    transition exactly-once. It doesn't — the read and the write aren't
    atomic, so two requests both reading the same due-scheduled item in the
    same instant both flip it and both notify the whole roster. Here, only the
    request whose UPDATE actually affects a row (`rowcount == 1`) has claimed
    the transition and gets to call `notify_one` for it; the loser's `UPDATE`
    affects zero rows and it stays silent.

    Every candidate in `due` — claimed or not — is refreshed from the database
    afterward, so the caller's in-memory objects (and their sort keys) reflect
    the actually-committed state even for an item this call lost the race on.
    """
    due = [
        item
        for item in items
        if getattr(item, "status") == scheduled_value
        and getattr(item, "scheduled_for")
        and as_utc(getattr(item, "scheduled_for")) <= now
    ]
    if not due:
        return

    claimed_ids: set[str] = set()
    for item in due:
        result = db.execute(
            update(model)
            .where(model.id == item.id, model.status == scheduled_value)  # type: ignore[attr-defined]
            .values(status=published_value, published_at=now, scheduled_for=None)
        )
        if result.rowcount == 1:
            claimed_ids.add(item.id)  # type: ignore[attr-defined]
    db.commit()

    for item in due:
        db.refresh(item)

    for item in due:
        if item.id in claimed_ids:  # type: ignore[attr-defined]
            notify_one(item)
