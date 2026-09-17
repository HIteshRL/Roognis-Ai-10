"""coursework quiz id

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-02

Sprint 3, T3.1 (the quiz bridge): links a coursework item of
`type == 'quiz'` to an approved quiz in `quiz_db`. No FK — `quiz_db` is a
different schema in the same Postgres instance, and frozen contract C7
forbids cross-schema FKs (LMS and Quiz stay independently deployable
services; the Quiz Service's own internal endpoint,
`GET /api/quiz/internal/quizzes/:quizId`, is the actual referential check,
enforced at write time in coursework.py, not by the database). Purely
additive, no backfill — every pre-existing row gets NULL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0016'
down_revision: Union[str, Sequence[str], None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'coursework',
        sa.Column('quiz_id', sa.String(length=36), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_coursework_quiz_id'), 'coursework', ['quiz_id'], unique=False, schema=SCHEMA)


def downgrade() -> None:
    op.drop_index(op.f('ix_coursework_quiz_id'), table_name='coursework', schema=SCHEMA)
    op.drop_column('coursework', 'quiz_id', schema=SCHEMA)
