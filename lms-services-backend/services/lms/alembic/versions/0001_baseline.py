"""baseline

Revision ID: 0001
Revises:
Create Date: 2026-08-31 17:04:45.824587

Generated with `alembic revision --autogenerate` against an empty
database, then hand-checked against services/lms/models.py (12 mapped
tables, all composite indexes and unique constraints) and hand-patched
to add explicit schema qualification everywhere — SCHEMA below, not a
hardcoded 'lms_db' literal, so this still tracks LMS_DB_SCHEMA if it's
ever changed. env.py creates the schema itself before this revision
runs, mirroring database.py's init_db().

Fresh-database baseline: no data exists yet, so there is no backfill
to narrate here. The next revision that alters a live column (e.g.
Sprint 1's C1 draft/allow_resubmission work) should follow
services/quiz's 20260730130000_quiz_approval_gate migration.sql for
how to document an operational consequence, not this one.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from config import get_settings

# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = get_settings().lms_db_schema or None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('classrooms',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('teacher_id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('subject', sa.String(length=120), nullable=False),
    sa.Column('section', sa.String(length=80), nullable=True),
    sa.Column('room', sa.String(length=80), nullable=True),
    sa.Column('grade', sa.String(length=40), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('color', sa.String(length=16), nullable=False),
    sa.Column('join_code', sa.String(length=16), nullable=False),
    sa.Column('join_code_enabled', sa.Boolean(), nullable=False),
    sa.Column('is_archived', sa.Boolean(), nullable=False),
    sa.Column('is_deleted', sa.Boolean(), nullable=False),
    sa.Column('settings', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_classrooms_join_code'), 'classrooms', ['join_code'], unique=True, schema=SCHEMA)
    op.create_index(op.f('ix_classrooms_school_id'), 'classrooms', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_classrooms_school_teacher', 'classrooms', ['school_id', 'teacher_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_classrooms_teacher_id'), 'classrooms', ['teacher_id'], unique=False, schema=SCHEMA)

    op.create_table('guardians',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('student_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('student_name', sa.String(length=160), nullable=True),
    sa.Column('guardian_email', sa.String(length=255), nullable=False),
    sa.Column('guardian_user_id', sa.String(length=36), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=True),
    sa.Column('invited_by', sa.String(length=36), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('student_id', 'guardian_email', name='uq_guardian_student_email'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_guardians_guardian_user_id'), 'guardians', ['guardian_user_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_guardians_school_id'), 'guardians', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_guardians_status'), 'guardians', ['status'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_guardians_student_id'), 'guardians', ['student_id'], unique=False, schema=SCHEMA)

    op.create_table('notifications',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('user_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('type', sa.String(length=40), nullable=False),
    sa.Column('title', sa.String(length=240), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('is_read', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_notifications_is_read'), 'notifications', ['is_read'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_notifications_school_id'), 'notifications', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_notifications_user_id'), 'notifications', ['user_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_notifications_user_read', 'notifications', ['user_id', 'is_read'], unique=False, schema=SCHEMA)

    op.create_table('announcements',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('author_id', sa.String(length=36), nullable=False),
    sa.Column('author_name', sa.String(length=160), nullable=True),
    sa.Column('title', sa.String(length=240), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('attachments', sa.JSON(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('scheduled_for', sa.DateTime(timezone=True), nullable=True),
    sa.Column('is_pinned', sa.Boolean(), nullable=False),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('is_deleted', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_announcements_author_id'), 'announcements', ['author_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_announcements_classroom_id'), 'announcements', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_announcements_classroom_status', 'announcements', ['classroom_id', 'status'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_announcements_school_id'), 'announcements', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_announcements_status'), 'announcements', ['status'], unique=False, schema=SCHEMA)

    op.create_table('chapters',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('title', sa.String(length=220), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('order_index', sa.Integer(), nullable=False),
    sa.Column('is_published', sa.Boolean(), nullable=False),
    sa.Column('knowledge_base_id', sa.String(length=36), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_chapters_classroom_id'), 'chapters', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_chapters_classroom_order', 'chapters', ['classroom_id', 'order_index'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_chapters_knowledge_base_id'), 'chapters', ['knowledge_base_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_chapters_school_id'), 'chapters', ['school_id'], unique=False, schema=SCHEMA)

    op.create_table('comments',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('author_id', sa.String(length=36), nullable=False),
    sa.Column('author_name', sa.String(length=160), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('coursework_id', sa.String(length=36), nullable=True),
    sa.Column('announcement_id', sa.String(length=36), nullable=True),
    sa.Column('parent_id', sa.String(length=36), nullable=True),
    sa.Column('mentions', sa.JSON(), nullable=False),
    sa.Column('is_deleted', sa.Boolean(), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_comments_announcement_id'), 'comments', ['announcement_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_comments_author_id'), 'comments', ['author_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_comments_classroom_id'), 'comments', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_comments_coursework_id'), 'comments', ['coursework_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_comments_parent_id'), 'comments', ['parent_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_comments_school_id'), 'comments', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_comments_thread', 'comments', ['classroom_id', 'coursework_id', 'announcement_id'], unique=False, schema=SCHEMA)

    op.create_table('enrollments',
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('student_id', sa.String(length=36), nullable=False),
    sa.Column('student_name', sa.String(length=160), nullable=True),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('classroom_id', 'student_id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_enrollments_school_id'), 'enrollments', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_enrollments_status'), 'enrollments', ['status'], unique=False, schema=SCHEMA)
    op.create_index('ix_enrollments_student_status', 'enrollments', ['student_id', 'status'], unique=False, schema=SCHEMA)

    op.create_table('rubrics',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('teacher_id', sa.String(length=36), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('criteria', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_rubrics_classroom_id'), 'rubrics', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_rubrics_school_id'), 'rubrics', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_rubrics_teacher_id'), 'rubrics', ['teacher_id'], unique=False, schema=SCHEMA)

    op.create_table('topics',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=160), nullable=False),
    sa.Column('order_index', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_topics_classroom_id'), 'topics', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_topics_classroom_order', 'topics', ['classroom_id', 'order_index'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_topics_school_id'), 'topics', ['school_id'], unique=False, schema=SCHEMA)

    op.create_table('comment_reactions',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('comment_id', sa.String(length=36), nullable=False),
    sa.Column('user_id', sa.String(length=36), nullable=False),
    sa.Column('emoji', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['comment_id'], [f'{SCHEMA + "." if SCHEMA else ""}comments.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('comment_id', 'user_id', 'emoji', name='uq_reaction_once'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_comment_reactions_comment_id'), 'comment_reactions', ['comment_id'], unique=False, schema=SCHEMA)

    op.create_table('coursework',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('classroom_id', sa.String(length=36), nullable=False),
    sa.Column('chapter_id', sa.String(length=36), nullable=True),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('teacher_id', sa.String(length=36), nullable=False),
    sa.Column('type', sa.String(length=20), nullable=False),
    sa.Column('title', sa.String(length=240), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('topic', sa.String(length=160), nullable=True),
    sa.Column('topic_id', sa.String(length=36), nullable=True),
    sa.Column('max_points', sa.Numeric(precision=6, scale=2), nullable=True),
    sa.Column('due_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('attachments', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['chapter_id'], [f'{SCHEMA + "." if SCHEMA else ""}chapters.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['classroom_id'], [f'{SCHEMA + "." if SCHEMA else ""}classrooms.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['topic_id'], [f'{SCHEMA + "." if SCHEMA else ""}topics.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_coursework_chapter_id'), 'coursework', ['chapter_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_coursework_classroom_id'), 'coursework', ['classroom_id'], unique=False, schema=SCHEMA)
    op.create_index('ix_coursework_classroom_status', 'coursework', ['classroom_id', 'status'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_coursework_school_id'), 'coursework', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_coursework_status'), 'coursework', ['status'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_coursework_teacher_id'), 'coursework', ['teacher_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_coursework_topic_id'), 'coursework', ['topic_id'], unique=False, schema=SCHEMA)

    op.create_table('submissions',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('coursework_id', sa.String(length=36), nullable=False),
    sa.Column('student_id', sa.String(length=36), nullable=False),
    sa.Column('student_name', sa.String(length=160), nullable=True),
    sa.Column('school_id', sa.String(length=36), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('content', sa.JSON(), nullable=False),
    sa.Column('grade', sa.Numeric(precision=6, scale=2), nullable=True),
    sa.Column('feedback', sa.Text(), nullable=True),
    sa.Column('turned_in_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('graded_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('graded_by', sa.String(length=36), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['coursework_id'], [f'{SCHEMA + "." if SCHEMA else ""}coursework.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('coursework_id', 'student_id', name='uq_submission_coursework_student'),
    schema=SCHEMA,
    )
    op.create_index(op.f('ix_submissions_coursework_id'), 'submissions', ['coursework_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_submissions_school_id'), 'submissions', ['school_id'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_submissions_status'), 'submissions', ['status'], unique=False, schema=SCHEMA)
    op.create_index('ix_submissions_student', 'submissions', ['student_id', 'status'], unique=False, schema=SCHEMA)
    op.create_index(op.f('ix_submissions_student_id'), 'submissions', ['student_id'], unique=False, schema=SCHEMA)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_submissions_student_id'), table_name='submissions', schema=SCHEMA)
    op.drop_index('ix_submissions_student', table_name='submissions', schema=SCHEMA)
    op.drop_index(op.f('ix_submissions_status'), table_name='submissions', schema=SCHEMA)
    op.drop_index(op.f('ix_submissions_school_id'), table_name='submissions', schema=SCHEMA)
    op.drop_index(op.f('ix_submissions_coursework_id'), table_name='submissions', schema=SCHEMA)
    op.drop_table('submissions', schema=SCHEMA)

    op.drop_index(op.f('ix_coursework_topic_id'), table_name='coursework', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_teacher_id'), table_name='coursework', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_status'), table_name='coursework', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_school_id'), table_name='coursework', schema=SCHEMA)
    op.drop_index('ix_coursework_classroom_status', table_name='coursework', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_classroom_id'), table_name='coursework', schema=SCHEMA)
    op.drop_index(op.f('ix_coursework_chapter_id'), table_name='coursework', schema=SCHEMA)
    op.drop_table('coursework', schema=SCHEMA)

    op.drop_index(op.f('ix_comment_reactions_comment_id'), table_name='comment_reactions', schema=SCHEMA)
    op.drop_table('comment_reactions', schema=SCHEMA)

    op.drop_index(op.f('ix_topics_school_id'), table_name='topics', schema=SCHEMA)
    op.drop_index('ix_topics_classroom_order', table_name='topics', schema=SCHEMA)
    op.drop_index(op.f('ix_topics_classroom_id'), table_name='topics', schema=SCHEMA)
    op.drop_table('topics', schema=SCHEMA)

    op.drop_index(op.f('ix_rubrics_teacher_id'), table_name='rubrics', schema=SCHEMA)
    op.drop_index(op.f('ix_rubrics_school_id'), table_name='rubrics', schema=SCHEMA)
    op.drop_index(op.f('ix_rubrics_classroom_id'), table_name='rubrics', schema=SCHEMA)
    op.drop_table('rubrics', schema=SCHEMA)

    op.drop_index('ix_enrollments_student_status', table_name='enrollments', schema=SCHEMA)
    op.drop_index(op.f('ix_enrollments_status'), table_name='enrollments', schema=SCHEMA)
    op.drop_index(op.f('ix_enrollments_school_id'), table_name='enrollments', schema=SCHEMA)
    op.drop_table('enrollments', schema=SCHEMA)

    op.drop_index('ix_comments_thread', table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_school_id'), table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_parent_id'), table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_coursework_id'), table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_classroom_id'), table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_author_id'), table_name='comments', schema=SCHEMA)
    op.drop_index(op.f('ix_comments_announcement_id'), table_name='comments', schema=SCHEMA)
    op.drop_table('comments', schema=SCHEMA)

    op.drop_index(op.f('ix_chapters_school_id'), table_name='chapters', schema=SCHEMA)
    op.drop_index(op.f('ix_chapters_knowledge_base_id'), table_name='chapters', schema=SCHEMA)
    op.drop_index('ix_chapters_classroom_order', table_name='chapters', schema=SCHEMA)
    op.drop_index(op.f('ix_chapters_classroom_id'), table_name='chapters', schema=SCHEMA)
    op.drop_table('chapters', schema=SCHEMA)

    op.drop_index(op.f('ix_announcements_status'), table_name='announcements', schema=SCHEMA)
    op.drop_index(op.f('ix_announcements_school_id'), table_name='announcements', schema=SCHEMA)
    op.drop_index('ix_announcements_classroom_status', table_name='announcements', schema=SCHEMA)
    op.drop_index(op.f('ix_announcements_classroom_id'), table_name='announcements', schema=SCHEMA)
    op.drop_index(op.f('ix_announcements_author_id'), table_name='announcements', schema=SCHEMA)
    op.drop_table('announcements', schema=SCHEMA)

    op.drop_index('ix_notifications_user_read', table_name='notifications', schema=SCHEMA)
    op.drop_index(op.f('ix_notifications_user_id'), table_name='notifications', schema=SCHEMA)
    op.drop_index(op.f('ix_notifications_school_id'), table_name='notifications', schema=SCHEMA)
    op.drop_index(op.f('ix_notifications_is_read'), table_name='notifications', schema=SCHEMA)
    op.drop_table('notifications', schema=SCHEMA)

    op.drop_index(op.f('ix_guardians_student_id'), table_name='guardians', schema=SCHEMA)
    op.drop_index(op.f('ix_guardians_status'), table_name='guardians', schema=SCHEMA)
    op.drop_index(op.f('ix_guardians_school_id'), table_name='guardians', schema=SCHEMA)
    op.drop_index(op.f('ix_guardians_guardian_user_id'), table_name='guardians', schema=SCHEMA)
    op.drop_table('guardians', schema=SCHEMA)

    op.drop_index(op.f('ix_classrooms_teacher_id'), table_name='classrooms', schema=SCHEMA)
    op.drop_index('ix_classrooms_school_teacher', table_name='classrooms', schema=SCHEMA)
    op.drop_index(op.f('ix_classrooms_school_id'), table_name='classrooms', schema=SCHEMA)
    op.drop_index(op.f('ix_classrooms_join_code'), table_name='classrooms', schema=SCHEMA)
    op.drop_table('classrooms', schema=SCHEMA)
