"""notification dedupe key

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-01

Refinement pass, Phase 2.2: `_already_notified` in `todo.py` (due_soon/
overdue notifications, Sprint 2, P4) was check-then-act — it SELECTs the
user's notification history, and if no matching (type, courseworkId) row is
found, inserts one. Two concurrent `GET /student/todo` reads (a double-tap,
a client retry) can both pass that check before either has inserted, and
both insert — the guarantee the endpoint's own docstring claims ("three
consecutive reads produce exactly one notification, not three") only held
because the test suite's requests never actually overlapped.

`dedupe_key` makes the guarantee structural: it is NULL for every
notification type that doesn't opt in, and a unique constraint on
(user_id, dedupe_key) means the second of two racing inserts fails with an
IntegrityError instead of succeeding — caught by notify.emit's existing
begin_nested() savepoint (Phase 1.6), so it degrades to a silent no-op
exactly like any other already-fail-open notification failure.

No backfill: existing notifications get dedupe_key = NULL, which is
correct (the constraint doesn't apply to them) rather than incomplete.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0011'
down_revision: Union[str, Sequence[str], None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    op.add_column(
        'notifications',
        sa.Column('dedupe_key', sa.String(length=160), nullable=True),
        schema=SCHEMA,
    )
    op.create_unique_constraint(
        'uq_notifications_user_dedupe_key',
        'notifications',
        ['user_id', 'dedupe_key'],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint(
        'uq_notifications_user_dedupe_key', 'notifications', schema=SCHEMA, type_='unique'
    )
    op.drop_column('notifications', 'dedupe_key', schema=SCHEMA)
