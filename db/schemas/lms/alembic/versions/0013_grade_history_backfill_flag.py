"""grade history backfill flag

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-02

Refinement pass, Phase 6.2: adds `GradeHistory.is_backfilled`, schema-only —
the actual backfill (one reconstructed row per already-graded submission that
predates this table, i.e. graded before migration 0009) is a separate,
explicitly-run step (`backfill_grade_history.py`), not baked into this
migration. Every other migration in this chain is pure schema; a data
migration that silently populates rows on every fresh deploy — including a
brand-new database with nothing to backfill — would be a different kind of
change than the rest of this chain, and an operator running it against a
real production database should be able to check counts before and after
rather than have it fire unattended during `alembic upgrade head`.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0013'
down_revision: Union[str, Sequence[str], None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'grade_history',
        sa.Column('is_backfilled', sa.Boolean(), nullable=False, server_default=sa.false()),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('grade_history', 'is_backfilled', schema=SCHEMA)
