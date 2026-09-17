"""classroom groups

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-02

Sprint 3, T2.4: `classroom_groups` + `classroom_group_members`, a teacher
convenience for coursework targeting. Purely additive, no backfill. A
group's membership is never read back after a publish resolves it to
`coursework_targets` rows (decision D9), so this table has no relationship
to `coursework_targets` at the schema level — `CourseworkTarget.
source_group_id` (migration 0014) is provenance only.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0015'
down_revision: Union[str, Sequence[str], None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_table(
        'classroom_groups',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('classroom_id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_classroom_groups_classroom_id'), 'classroom_groups', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_classroom_groups_school_id'), 'classroom_groups', ['school_id'], unique=False, schema=SCHEMA)

    op.create_table(
        'classroom_group_members',
        sa.Column('group_id', sa.String(length=36), nullable=False),
        sa.Column('student_id', sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ['group_id'],
            [f'{SCHEMA + "." if SCHEMA else ""}classroom_groups.id'],
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('group_id', 'student_id'),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table('classroom_group_members', schema=SCHEMA)
    op.drop_index(op.f('ix_classroom_groups_school_id'), table_name='classroom_groups', schema=SCHEMA)
    op.drop_index(op.f('ix_classroom_groups_classroom_id'), table_name='classroom_groups', schema=SCHEMA)
    op.drop_table('classroom_groups', schema=SCHEMA)
