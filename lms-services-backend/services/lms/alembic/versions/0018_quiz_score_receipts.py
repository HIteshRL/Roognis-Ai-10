"""Deduplicate authoritative quiz score delivery."""
from alembic import op
import sqlalchemy as sa
from config import get_settings
revision = '0018'
down_revision = '0017'
branch_labels = depends_on = None
SCHEMA = get_settings().lms_db_schema or None

def upgrade():
    op.create_table('quiz_score_receipts',
        sa.Column('attempt_id',sa.String(64),primary_key=True),
        sa.Column('coursework_id',sa.String(36),nullable=False),
        sa.Column('student_id',sa.String(36),nullable=False),
        sa.Column('created_at',sa.DateTime(timezone=True),server_default=sa.func.now(),nullable=False),schema=SCHEMA)

def downgrade():
    op.drop_table('quiz_score_receipts',schema=SCHEMA)
