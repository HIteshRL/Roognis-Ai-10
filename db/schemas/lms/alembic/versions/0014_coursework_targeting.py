"""coursework targeting

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-02

Sprint 3, T2.1 (frozen contract C8, decision D8): per-student/group
assignment targeting. `Coursework.target_mode` defaults to 'all' — every
pre-existing row backfills to class-wide, unchanged behaviour. Sparse by
design: `coursework_targets` only ever holds rows for a targeted
assignment, never one row per student for an 'all' assignment — the same
reasoning Sprint 1's C2 used to reject materialising an `assigned` row per
student (an N-row write at publish, plus a backfill for late enrollments).

`school_id` on `coursework_targets` is populated from the parent
coursework, never the request body, per frozen contract C7. No FK to
`enrollments` (composite PK, no surrogate id) — a removed student's target
row is intentionally left in place rather than cascade-deleted, so
re-enrolling restores the original targeting instead of silently widening
it to 'all' by the row's absence.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0014'
down_revision: Union[str, Sequence[str], None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'coursework',
        sa.Column(
            'target_mode',
            sa.String(length=20),
            nullable=False,
            server_default='all',
        ),
        schema=SCHEMA,
    )
    op.create_table(
        'coursework_targets',
        sa.Column('coursework_id', sa.String(length=36), nullable=False),
        sa.Column('student_id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        # Provenance only — which group (if any) resolved to this row at
        # publish time. Not read by any visibility query; a group's own
        # membership can change after publish without moving the target.
        sa.Column('source_group_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['coursework_id'],
            [f'{SCHEMA + "." if SCHEMA else ""}coursework.id'],
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('coursework_id', 'student_id'),
        schema=SCHEMA,
    )
    op.create_index(
        op.f('ix_coursework_targets_school_id'), 'coursework_targets', ['school_id'], unique=False, schema=SCHEMA
    )
    op.create_index(
        op.f('ix_coursework_targets_student_id'), 'coursework_targets', ['student_id'], unique=False, schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_coursework_targets_student_id'), table_name='coursework_targets', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_targets_school_id'), table_name='coursework_targets', schema=SCHEMA)
    op.drop_table('coursework_targets', schema=SCHEMA)
    op.drop_column('coursework', 'target_mode', schema=SCHEMA)
