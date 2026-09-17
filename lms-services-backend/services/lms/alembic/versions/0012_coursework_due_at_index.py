"""coursework due_at index

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-01

Refinement pass, Phase 3.1: `Coursework.due_at` had no index despite being
filtered by `calendar_view.py`'s date-range query, `gradebook.py`'s
`build_missing_work`, and bucketed by `todo.py`'s due-today/overdue split —
the one real gap in an otherwise well-covered table (school_id, classroom_id,
student_id are indexed everywhere, and the composites already present match
the real query shapes). Composite on (classroom_id, due_at) rather than
due_at alone, since every one of those call sites already scopes to a
classroom or a set of classrooms first.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_index(
        op.f('ix_coursework_classroom_due'),
        'coursework',
        ['classroom_id', 'due_at'],
        unique=False,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_coursework_classroom_due'), table_name='coursework', schema=SCHEMA)
