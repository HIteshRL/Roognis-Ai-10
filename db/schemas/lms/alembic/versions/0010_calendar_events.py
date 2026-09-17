"""calendar events

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-01

Sprint 2, P4: adds the `calendar_events` table for one-off classroom
events (exams, field trips) that exist independently of
`Coursework.due_at`. Purely additive, no backfill.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_table(
        'calendar_events',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('classroom_id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=240), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ends_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_calendar_events_classroom_id'), 'calendar_events', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_calendar_events_school_id'), 'calendar_events', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_calendar_events_starts_at'), 'calendar_events', ['starts_at'], unique=False, schema=SCHEMA)
    op.create_index(
        'ix_calendar_events_classroom_starts', 'calendar_events', ['classroom_id', 'starts_at'], unique=False, schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index('ix_calendar_events_classroom_starts', table_name='calendar_events', schema=SCHEMA)
    op.drop_index(op.f('ix_calendar_events_starts_at'), table_name='calendar_events', schema=SCHEMA)
    op.drop_index(op.f('ix_calendar_events_school_id'), table_name='calendar_events', schema=SCHEMA)
    op.drop_index(op.f('ix_calendar_events_classroom_id'), table_name='calendar_events', schema=SCHEMA)
    op.drop_table('calendar_events', schema=SCHEMA)
