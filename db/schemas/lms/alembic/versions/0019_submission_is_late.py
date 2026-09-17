"""submission is_late

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-16

Adds Submission.is_late. Backfilled false (server_default) for every
existing row — lateness for rows that predate this column is unknowable
without a decision about what "late" meant at the time they were turned
in, and false is the safe reading (never flag a pre-existing submission
as late that wasn't recorded as such). Set once, at turn-in time, by
comparing turned_in_at against coursework.due_at; not recomputed if a
teacher edits due_at afterward (see submit_coursework in coursework.py).

Kept as a boolean alongside the existing `status` column rather than a
new SubmissionStatus.LATE enum value — status == TURNED_IN is branched on
across coursework.py, todo.py, gradebook.py and web/src, and a parallel
status would require updating every one of those call sites. is_late is
purely additive.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0019'
down_revision: Union[str, Sequence[str], None] = '0018'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'submissions',
        sa.Column(
            'is_late',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('submissions', 'is_late', schema=SCHEMA)
