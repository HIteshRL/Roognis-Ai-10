"""One-off backfill: a reconstructed GradeHistory row for every Submission
that was graded before the grade_history table existed (migration 0009,
Sprint 2, P3), so a class that had grading activity before that date isn't
left with a suspiciously-empty audit trail for its oldest work.

Run manually, once, after migration 0013 (which adds the `is_backfilled`
column this script relies on) — not part of `alembic upgrade head` itself.
See `CLAUDE.md`'s migration entry for why: this is a data change, not a
schema one, and an operator running it against a real database should be
able to check counts before and after rather than have it fire unattended.

    python backfill_grade_history.py            # dry run, prints what it would do
    python backfill_grade_history.py --apply     # actually inserts

Deliberately narrow in what it can honestly claim:

- Each backfilled row reflects the submission's *current* grade/feedback/
  rubric_scores/status — there is no record of what an earlier re-grade
  actually changed, so a submission re-graded three times before this
  script ever runs gets exactly one row, not three. `is_backfilled=True`
  marks every row this script writes, so a consumer of the history can
  tell "this is a reconstruction of current state" from "this is an
  observation of one specific grading event" — the two must never be
  silently mixed (see GradeHistory's own docstring in models.py).
- `returned` is derived from the submission's *current* status
  (`status == 'returned'`), matching Phase 1.1's withholding fix: a
  backfilled row for a submission that is not currently returned must
  itself read as not-returned, or 1.1's fix would have to hide a row this
  script just manufactured.
- Idempotent: a submission that already has any grade_history row (real or
  previously backfilled) is skipped, so running this twice — or running it
  after grading activity has already started populating real rows — never
  produces a duplicate.
"""
from __future__ import annotations

import argparse
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from database import SessionLocal
from models import GradeHistory, Submission, SubmissionStatus

logger = logging.getLogger(__name__)


def run_backfill(db: Session, *, apply: bool) -> int:
    """Returns the number of rows that were (or, in dry-run, would be)
    inserted."""
    already_has_history = set(db.scalars(select(GradeHistory.submission_id)).all())

    query = select(Submission).where(Submission.grade.is_not(None))
    if already_has_history:
        query = query.where(Submission.id.not_in(already_has_history))
    graded = list(db.scalars(query).all())

    count = 0
    for submission in graded:
        count += 1
        if not apply:
            continue
        db.add(
            GradeHistory(
                submission_id=submission.id,
                school_id=submission.school_id,
                # Copying the real grader rather than a placeholder — who
                # graded it is accurate historical fact even though *when*
                # (relative to any re-grades) is not.
                graded_by=submission.graded_by or "unknown",
                grade=submission.grade,
                feedback=submission.feedback,
                rubric_scores=submission.rubric_scores,
                returned=submission.status == SubmissionStatus.RETURNED.value,
                is_backfilled=True,
                # The actual grading timestamp, not "now" — keeps a
                # backfilled row in its correct chronological position
                # alongside any real rows added after this script runs.
                created_at=submission.graded_at,
            )
        )

    if apply:
        db.commit()
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, only reports the count.",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        count = run_backfill(db, apply=args.apply)
        if args.apply:
            print(f"Backfilled {count} grade_history row(s).")
        else:
            print(f"Dry run: would backfill {count} grade_history row(s). Re-run with --apply to write them.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
