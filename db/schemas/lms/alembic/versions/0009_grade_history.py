"""grade history

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-01

Sprint 2, P3: adds the `grade_history` table — an append-only audit row
per `grade_submission` call. Purely additive, no backfill: existing
submissions that were already graded before this migration get no
retroactive history rows (there is no reliable source for what an earlier
re-grade actually changed), only their current `Submission.grade` state.
History starts accumulating from the next grading action onward.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_table(
        'grade_history',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('submission_id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        sa.Column('graded_by', sa.String(length=36), nullable=False),
        sa.Column('grade', sa.Numeric(precision=6, scale=2), nullable=False),
        sa.Column('feedback', sa.Text(), nullable=True),
        sa.Column('rubric_scores', sa.JSON(), nullable=True),
        sa.Column('returned', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['submission_id'], [f'{SCHEMA + "." if SCHEMA else ""}submissions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_grade_history_submission_id'), 'grade_history', ['submission_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_grade_history_school_id'), 'grade_history', ['school_id'], unique=False, schema=SCHEMA)


def downgrade() -> None:
    op.drop_index(op.f('ix_grade_history_school_id'), table_name='grade_history', schema=SCHEMA)
    op.drop_index(op.f('ix_grade_history_submission_id'), table_name='grade_history', schema=SCHEMA)
    op.drop_table('grade_history', schema=SCHEMA)
