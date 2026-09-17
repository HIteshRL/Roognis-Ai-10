"""comment visibility

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-01

Sprint 2, P3: adds `Comment.submission_id` + `Comment.visibility`, backing
private teacher<->student comments on a submission. Purely additive —
every existing comment gets submission_id=NULL, visibility='class'
(server_default), meaning "the classroom-wide discussion comment it always
was" — no existing row's meaning changes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'comments',
        sa.Column('submission_id', sa.String(length=36), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        'comments',
        sa.Column('visibility', sa.String(length=20), nullable=False, server_default='class'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_comments_submission_id'), 'comments', ['submission_id'], unique=False, schema=SCHEMA)


def downgrade() -> None:
    op.drop_index(op.f('ix_comments_submission_id'), table_name='comments', schema=SCHEMA)
    op.drop_column('comments', 'visibility', schema=SCHEMA)
    op.drop_column('comments', 'submission_id', schema=SCHEMA)
