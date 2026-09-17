"""guardian redeemable code + expiry

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-16

Guardian-linking redesign: `guardians.py`'s teacher-facing invite flow
already wrote a `token` column, but its own module docstring recorded the
accept-by-token flow as "intentionally omitted" — nothing ever read it, and
the actual authorization link (`auth_db.parentStudent`, which populates a
parent JWT's `studentIds`) was never wired up from it. This migration turns
`token` into a genuinely redeemable, human-shareable code (regenerated going
forward via `models.generate_guardian_code`, the same unambiguous alphabet
`generate_join_code` uses for classroom join codes — the product decision
was to mirror that existing pattern, not invent a new one) and adds the
expiry the classroom join-code pattern doesn't need: a classroom code is
long-lived and reusable across many students, but a guardian code is scoped
to one student and must lapse.

Existing `token` values (opaque `secrets.token_urlsafe(24)` strings that were
never redeemable) are left as-is — any still-`pending` row simply gets a
fresh, short code the next time it is regenerated or re-invited. A unique
index on `token` is safe to add here: `token_urlsafe(24)` collisions across
the existing dataset are cryptographically negligible, and NULLs (rows that
somehow never got a token) do not conflict with each other under a standard
btree unique index.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = "0020"
down_revision: Union[str, Sequence[str], None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        "guardians",
        sa.Column("code_expires_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        op.f("ix_guardians_token"), "guardians", ["token"], unique=True, schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_guardians_token"), table_name="guardians", schema=SCHEMA)
    op.drop_column("guardians", "code_expires_at", schema=SCHEMA)
