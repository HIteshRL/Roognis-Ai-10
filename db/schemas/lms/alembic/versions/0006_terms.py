"""terms

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-01

Sprint 2, P1: adds the `terms` table (school-scoped academic terms) and
`classrooms.term_id` (nullable FK, SET NULL on delete). Purely additive —
every existing classroom gets term_id=NULL, meaning "no term assigned",
the same absence-convention 0004/0005 already established for optional
columns on this service's other tables.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_table(
        'terms',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('start_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('end_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('is_current', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_terms_school_id'), 'terms', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_terms_school_current', 'terms', ['school_id', 'is_current'], unique=False, schema=SCHEMA)

    op.add_column(
        'classrooms',
        sa.Column('term_id', sa.String(length=36), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_classrooms_term_id'), 'classrooms', ['term_id'], unique=False, schema=SCHEMA)
    op.create_foreign_key(
        'fk_classrooms_term_id_terms',
        'classrooms',
        'terms',
        ['term_id'],
        ['id'],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_classrooms_term_id_terms', 'classrooms', schema=SCHEMA, type_='foreignkey')
    op.drop_index(op.f('ix_classrooms_term_id'), table_name='classrooms', schema=SCHEMA)
    op.drop_column('classrooms', 'term_id', schema=SCHEMA)

    op.drop_index('ix_terms_school_current', table_name='terms', schema=SCHEMA)
    op.drop_index(op.f('ix_terms_school_id'), table_name='terms', schema=SCHEMA)
    op.drop_table('terms', schema=SCHEMA)
