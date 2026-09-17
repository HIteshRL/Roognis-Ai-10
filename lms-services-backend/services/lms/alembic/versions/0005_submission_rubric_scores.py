"""submission rubric scores

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-31

Sprint 1, T3.4: adds Submission.rubric_scores ([{criterion, points}],
nullable). Purely additive — no backfill, existing rows get NULL, meaning
"graded without a rubric breakdown", the same absence-convention
0004 already established for Coursework.rubric_criteria.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'submissions',
        sa.Column('rubric_scores', sa.JSON(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('submissions', 'rubric_scores', schema=SCHEMA)
