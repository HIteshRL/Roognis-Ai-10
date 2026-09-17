"""Background scheduler for the due-date notification sweep
(`todo.run_due_date_notification_sweep`) — the proactive counterpart to
`GET /student/todo`'s on-read firing, so `due_soon`/`overdue` notifications
reach a student even if they never open the app.

An asyncio task on the FastAPI lifespan, ticking on
`settings.lms_notification_sweep_interval_seconds`. No new dependency and no
new container: `services/lms/requirements.txt` has no scheduler package and
needs none, matching the `CLAUDE.md` rule against building scaling
infrastructure ahead of a demonstrated need. The sweep's own idempotency
(`dedupe_key`, Phase 2.2) is what makes this safe without a claim-lease
table — see `run_due_date_notification_sweep`'s docstring for the full
reasoning.

The sweep's DB work is synchronous SQLAlchemy, like the rest of this
service, so it runs via `asyncio.to_thread` rather than blocking the event
loop for the duration of a full sweep.
"""
from __future__ import annotations

import asyncio
import logging

from database import SessionLocal
from todo import run_due_date_notification_sweep

logger = logging.getLogger(__name__)


def _run_sweep_sync() -> int:
    db = SessionLocal()
    try:
        return run_due_date_notification_sweep(db)
    finally:
        db.close()


async def _tick() -> None:
    try:
        swept = await asyncio.to_thread(_run_sweep_sync)
        logger.info("due-date notification sweep: %d active student(s) checked", swept)
    except Exception:
        # One bad tick must never kill the loop — the next tick tries again,
        # same fail-open reasoning as notify.emit itself.
        logger.exception("due-date notification sweep failed")


async def run_forever(interval_seconds: int) -> None:
    """Runs until the task is cancelled (the lifespan cancels it on
    shutdown). Ticks immediately on startup, then every `interval_seconds`
    — so a freshly-deployed instance doesn't leave students unswept for a
    full interval before the first run."""
    while True:
        await _tick()
        await asyncio.sleep(interval_seconds)
