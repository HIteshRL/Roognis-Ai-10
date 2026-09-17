"""uploads

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-01

Sprint 2, P2 / D5: adds the `uploads` table backing the real attachment
upload endpoint (`uploads.py`). Purely additive, no backfill — existing
`{type,url,title}` attachment entries (0004) already point at external
URLs and are untouched by this.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.create_table(
        'uploads',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('school_id', sa.String(length=36), nullable=False),
        sa.Column('uploaded_by', sa.String(length=36), nullable=False),
        sa.Column('original_filename', sa.String(length=255), nullable=False),
        sa.Column('content_type', sa.String(length=120), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('storage_path', sa.String(length=500), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        schema=SCHEMA,
    )
    op.create_index(op.f('ix_uploads_school_id'), 'uploads', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_uploads_uploaded_by'), 'uploads', ['uploaded_by'], unique=False, schema=SCHEMA)


def downgrade() -> None:
    op.drop_index(op.f('ix_uploads_uploaded_by'), table_name='uploads', schema=SCHEMA)
    op.drop_index(op.f('ix_uploads_school_id'), table_name='uploads', schema=SCHEMA)
    op.drop_table('uploads', schema=SCHEMA)
