"""coursework allow resubmission

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-31

Sprint 1, T2.2 / frozen contract C1: adds Coursework.allow_resubmission.
Backfilled true (server_default) for every existing row, matching the
pre-C1 de-facto behavior — submit_coursework already let a student
resubmit as many times as they liked until the submission was returned.
Without this default, every assignment created before this migration
would silently gain a new restriction (no resubmission at all) the moment
this code deploys, which is not what C1 asks for: the flag is meant to be
an opt-in restriction a teacher chooses per assignment, not a retroactive
tightening of every assignment that already exists.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'coursework',
        sa.Column(
            'allow_resubmission',
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('coursework', 'allow_resubmission', schema=SCHEMA)
