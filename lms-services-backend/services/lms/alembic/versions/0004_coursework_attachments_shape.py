"""coursework attachments shape

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-31

Sprint 1, T2.3: Coursework.attachments moves from a JSON dict
({"links": [...], "files": [...], "rubric": [...]}) to the same
[{"type", "url", "title"}] list shape Announcement already uses, so both
render through one frontend renderer (TimelineAttachment.tsx). The DB
column stays plain JSON either way — nothing to alter there — but the
data inside every existing row needs reshaping, and the rubric criteria
that used to live at attachments["rubric"] need to move to their own new
column (rubrics.py's attach_rubric wrote there only because attachments
was the only free-form field available; now it has a proper home).

This is deliberately visible, not silent: any coursework row created
before this migration keeps its links/files, now list-shaped, and any
attached rubric keeps rendering — but through rubricCriteria, not
attachments.rubric. A frontend still reading the old shape after this
lands would see nothing (an empty rubric section, missing attachments),
so this migration and the coursework.py/rubrics.py/frontend code changes
in the same commit are not separable.

Backfill runs as a plain Python loop over each row rather than raw jsonb
SQL — the row count here is dev/demo-scale, and correctness of a one-time
shape transform is easier to verify read as Python than as jsonb path
expressions.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def _coursework_table():
    return sa.table(
        'coursework',
        sa.column('id', sa.String),
        sa.column('attachments', sa.JSON),
        sa.column('rubric_criteria', sa.JSON),
        schema=SCHEMA,
    )


def upgrade() -> None:
    op.add_column(
        'coursework',
        sa.Column('rubric_criteria', sa.JSON(), nullable=True),
        schema=SCHEMA,
    )

    coursework = _coursework_table()
    conn = op.get_bind()
    rows = conn.execute(sa.select(coursework.c.id, coursework.c.attachments)).fetchall()
    for row in rows:
        old = row.attachments or {}
        if not isinstance(old, dict):
            # Already list-shaped (shouldn't happen pre-migration, but a
            # re-run or a hand-edited row should not crash the backfill).
            continue

        new_attachments = []
        for link in old.get('links') or []:
            new_attachments.append(
                {'type': 'link', 'url': link.get('url'), 'title': link.get('title') or link.get('url')}
            )
        for file in old.get('files') or []:
            new_attachments.append(
                {'type': 'file', 'url': file.get('url'), 'title': file.get('name') or file.get('title')}
            )

        conn.execute(
            coursework.update()
            .where(coursework.c.id == row.id)
            .values(attachments=new_attachments, rubric_criteria=old.get('rubric'))
        )


def downgrade() -> None:
    coursework = _coursework_table()
    conn = op.get_bind()
    rows = conn.execute(
        sa.select(coursework.c.id, coursework.c.attachments, coursework.c.rubric_criteria)
    ).fetchall()
    for row in rows:
        items = row.attachments or []
        old = {
            'links': [{'url': a.get('url'), 'title': a.get('title')} for a in items if a.get('type') != 'file'],
            'files': [{'url': a.get('url'), 'name': a.get('title')} for a in items if a.get('type') == 'file'],
        }
        if row.rubric_criteria:
            old['rubric'] = row.rubric_criteria
        conn.execute(coursework.update().where(coursework.c.id == row.id).values(attachments=old))

    op.drop_column('coursework', 'rubric_criteria', schema=SCHEMA)
