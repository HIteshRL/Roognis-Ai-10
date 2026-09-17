"""Add curriculum versions after the unchanged engineer migration chain."""
from alembic import op
import sqlalchemy as sa
from config import get_settings
revision = "0017"
down_revision = "0016"
branch_labels = depends_on = None
SCHEMA = get_settings().lms_db_schema or None

def upgrade():
    op.create_table("curriculum_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("chapter_id", sa.String(36), sa.ForeignKey(f"{SCHEMA + '.' if SCHEMA else ''}chapters.id", ondelete="CASCADE"), nullable=False),
        sa.Column("school_id", sa.String(36), nullable=False),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("context", sa.JSON(), nullable=False),
        sa.Column("concepts", sa.JSON(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), schema=SCHEMA)
    for field in ("chapter_id", "school_id", "document_id"):
        op.create_index("ix_curriculum_versions_" + field, "curriculum_versions", [field], schema=SCHEMA)

def downgrade():
    op.drop_table("curriculum_versions", schema=SCHEMA)
