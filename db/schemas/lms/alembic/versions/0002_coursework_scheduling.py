"""coursework scheduling

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-31

Sprint 1, T2.1: adds Coursework.scheduled_for plus a composite
(status, scheduled_for) index so the lazy-publish read path
(coursework.py::list_published_coursework) can cheaply find due rows.
Purely additive — no backfill needed, existing rows get NULL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'coursework',
        sa.Column('scheduled_for', sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        'ix_coursework_status_scheduled',
        'coursework',
        ['status', 'scheduled_for'],
        unique=False,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index('ix_coursework_status_scheduled', table_name='coursework', schema=SCHEMA)
    op.drop_column('coursework', 'scheduled_for', schema=SCHEMA)
