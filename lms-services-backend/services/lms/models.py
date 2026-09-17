"""SQLAlchemy models for the LMS / Classroom service (schema: lms_db).

Ported from Roognis v2's `services/learner` + `core/models` (Google Classroom
model), collapsed from v2's repository/DTO abstraction into the direct-ORM style
main4's RAG service uses. User and school identifiers are plain strings owned by
the Auth Service (auth_db) — no cross-schema foreign keys, preserving the
microservice boundary.
"""
from __future__ import annotations

import enum
import secrets
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


# Unambiguous alphabet — no 0/O/1/I/L — for human-typed join codes.
_JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# Same alphabet as a classroom join code, one character longer: a guardian
# code identifies a single (student, invite) pair rather than a whole
# classroom, so the collision space matters a bit more even though it's
# still enforced by a real unique index, not just entropy.
_GUARDIAN_CODE_ALPHABET = _JOIN_CODE_ALPHABET

# Google-Classroom-style header palette; assigned round-robin per teacher.
CLASSROOM_COLORS = [
    "#1967d2",
    "#188038",
    "#a142f4",
    "#e37400",
    "#d01884",
    "#00897b",
    "#c5221f",
    "#3949ab",
]


def generate_join_code(length: int = 7) -> str:
    return "".join(secrets.choice(_JOIN_CODE_ALPHABET) for _ in range(length))


def generate_guardian_code(length: int = 8) -> str:
    """A short, human-typeable redeemable code for the guardian-linking flow —
    same shape as `generate_join_code`, deliberately: the product decision was
    to mirror the classroom join-code pattern rather than invent a second one.
    Unlike a join code (long-lived, reusable, one per classroom), a guardian
    code is scoped to a single (student, invite) row, is one-time-use (the
    row's own `status` flip from "pending" to "active" enforces that — no
    separate "used" flag needed), and expires (`Guardian.code_expires_at`)."""
    return "".join(secrets.choice(_GUARDIAN_CODE_ALPHABET) for _ in range(length))


class EnrollmentStatus(str, enum.Enum):
    PENDING = "pending"
    ACTIVE = "active"
    REMOVED = "removed"


class EnrollmentRole(str, enum.Enum):
    STUDENT = "student"
    CO_TEACHER = "co_teacher"


class CourseworkType(str, enum.Enum):
    ASSIGNMENT = "assignment"
    QUIZ = "quiz"
    QUESTION = "question"
    MATERIAL = "material"


class CourseworkStatus(str, enum.Enum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"


class CourseworkTargetMode(str, enum.Enum):
    ALL = "all"
    STUDENTS = "students"


class SubmissionStatus(str, enum.Enum):
    DRAFT = "draft"
    ASSIGNED = "assigned"
    TURNED_IN = "turned_in"
    RETURNED = "returned"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Term(Base, TimestampMixin):
    """A school-scoped academic term (e.g. "2026-27" or "Term 1"). Not
    per-teacher — any teacher in the school can see and use it, the same way
    a school's academic calendar isn't owned by one class. At most one term
    per school may have ``is_current=True``; enforced in classrooms.py, not
    at the schema level, since a partial unique index needs a
    Postgres-specific expression and the SQLite test path doesn't support
    it."""

    __tablename__ = "terms"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    start_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (
        Index("ix_terms_school_current", "school_id", "is_current"),
    )


class Classroom(Base, TimestampMixin):
    __tablename__ = "classrooms"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    teacher_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    # Nullable: classrooms created before Sprint 2 (or in a school that
    # hasn't set up terms yet) have no term. SET NULL on delete so removing
    # a term orphans its classrooms rather than cascading the delete.
    term_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("terms.id", ondelete="SET NULL"),
        index=True,
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    subject: Mapped[str] = mapped_column(String(120), nullable=False)
    section: Mapped[str | None] = mapped_column(String(80))
    room: Mapped[str | None] = mapped_column(String(80))
    grade: Mapped[str | None] = mapped_column(String(40))
    description: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str] = mapped_column(String(16), nullable=False, default=CLASSROOM_COLORS[0])
    join_code: Mapped[str] = mapped_column(String(16), nullable=False, unique=True, index=True)
    join_code_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    settings: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="classroom",
        cascade="all, delete-orphan",
    )
    enrollments: Mapped[list[Enrollment]] = relationship(
        back_populates="classroom",
        cascade="all, delete-orphan",
    )
    coursework: Mapped[list[Coursework]] = relationship(
        back_populates="classroom",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_classrooms_school_teacher", "school_id", "teacher_id"),
    )


class Chapter(Base, TimestampMixin):
    __tablename__ = "chapters"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(220), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Optional link to a RAG document grouping so chat/quiz can scope to a chapter.
    knowledge_base_id: Mapped[str | None] = mapped_column(String(36), index=True)

    classroom: Mapped[Classroom] = relationship(back_populates="chapters")
    coursework: Mapped[list[Coursework]] = relationship(back_populates="chapter")

    __table_args__ = (
        Index("ix_chapters_classroom_order", "classroom_id", "order_index"),
    )


class Enrollment(Base):
    __tablename__ = "enrollments"

    classroom_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        primary_key=True,
    )
    student_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    student_name: Mapped[str | None] = mapped_column(String(160))
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(20),
        default=EnrollmentStatus.ACTIVE.value,
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(
        String(20),
        default=EnrollmentRole.STUDENT.value,
        nullable=False,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    classroom: Mapped[Classroom] = relationship(back_populates="enrollments")

    __table_args__ = (
        Index("ix_enrollments_student_status", "student_id", "status"),
    )


class Coursework(Base, TimestampMixin):
    __tablename__ = "coursework"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chapter_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("chapters.id", ondelete="SET NULL"),
        index=True,
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    teacher_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    type: Mapped[str] = mapped_column(
        String(20),
        default=CourseworkType.ASSIGNMENT.value,
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    topic: Mapped[str | None] = mapped_column(String(160))
    # Classwork topic grouping (Google Classroom "Classwork" tab). SET NULL so
    # deleting a topic leaves its coursework in place, un-filed.
    topic_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("topics.id", ondelete="SET NULL"),
        index=True,
    )
    max_points: Mapped[float | None] = mapped_column(Numeric(6, 2))
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(
        String(20),
        default=CourseworkStatus.DRAFT.value,
        nullable=False,
        index=True,
    )
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Sprint 1 C1: gates whether a TURNED_IN (not draft) submission may be
    # resubmitted. Defaults true to match the pre-C1 de-facto behavior
    # (unlimited resubmission until returned) so existing rows don't
    # silently gain a new restriction.
    allow_resubmission: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    attachments: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    # A rubric's criteria, copied in by rubrics.py's attach_rubric. Its own
    # field, not folded into `attachments` — kept null when no rubric is
    # attached, unlike `attachments` which is always a list even when empty.
    rubric_criteria: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Sprint 3, T2.1 / frozen contract C8: 'all' (default, class-wide — the
    # only value every pre-Sprint-3 row has) or 'students'. Sparse by
    # design — `targets` only holds rows when this is 'students'; see
    # CourseworkTarget's docstring.
    target_mode: Mapped[str] = mapped_column(
        String(20),
        default=CourseworkTargetMode.ALL.value,
        nullable=False,
    )
    # Sprint 3, T3.1 (the quiz bridge): links a `type == 'quiz'` item to an
    # approved quiz in quiz_db. No FK — see the migration's docstring for
    # why. Set only via coursework.py::link_quiz, which validates against
    # the Quiz Service first (decision D10: only status == 'ready').
    quiz_id: Mapped[str | None] = mapped_column(String(36), index=True)

    classroom: Mapped[Classroom] = relationship(back_populates="coursework")
    chapter: Mapped[Chapter | None] = relationship(back_populates="coursework")
    submissions: Mapped[list[Submission]] = relationship(
        back_populates="coursework",
        cascade="all, delete-orphan",
    )
    targets: Mapped[list[CourseworkTarget]] = relationship(
        back_populates="coursework",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_coursework_classroom_status", "classroom_id", "status"),
        Index("ix_coursework_status_scheduled", "status", "scheduled_for"),
        # due_at was the one hot filter column with no index in this table —
        # filtered by calendar_view.py's date-range query, gradebook.py's
        # build_missing_work, and bucketed by todo.py's due-today/overdue
        # split. Index coverage elsewhere on this table was already good;
        # this closed the one real gap.
        Index("ix_coursework_classroom_due", "classroom_id", "due_at"),
    )


class Submission(Base, TimestampMixin):
    __tablename__ = "submissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    coursework_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("coursework.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    student_name: Mapped[str | None] = mapped_column(String(160))
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(20),
        default=SubmissionStatus.TURNED_IN.value,
        nullable=False,
        index=True,
    )
    content: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    grade: Mapped[float | None] = mapped_column(Numeric(6, 2))
    feedback: Mapped[str | None] = mapped_column(Text)
    # Sprint 1, T3.4: [{criterion, points}], set only when the teacher graded
    # against the coursework's attached rubric. `grade` (above) stays the
    # authoritative scalar either way — this is a breakdown, not a replacement.
    rubric_scores: Mapped[list | None] = mapped_column(JSON, nullable=True)
    turned_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set once, at the moment of turn-in, by comparing turned_in_at against
    # coursework.due_at — not a derived/computed property. Kept as a
    # boolean alongside `status` (rather than a new SubmissionStatus.LATE
    # value) deliberately: `status == TURNED_IN` is branched on across
    # coursework.py/todo.py/gradebook.py and web/src (stats, resubmission
    # gating, missing-work counts, grade withholding), and a parallel LATE
    # status would require touching every one of those call sites to keep
    # them correct. A boolean is purely additive. A submission that goes
    # late stays late even if the teacher later pushes the due date out —
    # see submit_coursework's docstring for why that isn't recomputed.
    is_late: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    graded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    graded_by: Mapped[str | None] = mapped_column(String(36))

    coursework: Mapped[Coursework] = relationship(back_populates="submissions")

    __table_args__ = (
        UniqueConstraint("coursework_id", "student_id", name="uq_submission_coursework_student"),
        Index("ix_submissions_student", "student_id", "status"),
    )


class CourseworkTarget(Base):
    """Sprint 3, T2.1 / decision D8: one row per student a `target_mode ==
    'students'` coursework item is assigned to. Sparse — a class-wide
    ('all') item writes zero rows here, the same reasoning Sprint 1's C2
    used to reject materialising an `assigned` row per student (an N-row
    write at publish, plus a backfill for every late enrollment).

    No FK to `enrollments`: a removed student's target row is left in
    place rather than cascade-deleted, so re-enrolling restores the
    original targeting instead of silently widening it to 'all' by the
    row's absence.

    `source_group_id` is provenance only (decision D9) — which group, if
    any, resolved to this row at publish time. A group's membership can
    change after publish without moving the target; nothing reads this
    column back to re-resolve membership.
    """

    __tablename__ = "coursework_targets"

    coursework_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("coursework.id", ondelete="CASCADE"),
        primary_key=True,
    )
    student_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    source_group_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    coursework: Mapped[Coursework] = relationship(back_populates="targets")

    __table_args__ = (
        Index("ix_coursework_targets_student", "student_id"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Google-Classroom parity layer — ported from v2 core/models/lms.py + learner.
# Stream announcements, threaded discussion comments + reactions, reusable
# rubrics, classwork topics, guardian links, and in-app notifications. Every row
# is school-scoped; user/school identity stays in auth_db (plain-string ids, no
# cross-schema FKs), the same boundary the classroom/coursework tables keep.
# ─────────────────────────────────────────────────────────────────────────────

ANNOUNCEMENT_STATUSES = ("draft", "scheduled", "published")
STREAM_PERMISSIONS = ("post_and_comment", "comment_only", "teachers_only")
GUARDIAN_STATUSES = ("pending", "active", "removed")


class Topic(Base, TimestampMixin):
    """Classwork topic — a teacher-owned grouping coursework is filed under."""

    __tablename__ = "topics"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    __table_args__ = (Index("ix_topics_classroom_order", "classroom_id", "order_index"),)


class ClassroomGroup(Base, TimestampMixin):
    """Sprint 3, T2.4: a teacher-defined student group, used only as a
    convenience for targeting coursework (decision D9) — a group's
    membership is resolved to a fixed set of `CourseworkTarget` rows at
    publish time and never read back later, so editing a group after
    publish never changes who an already-published item is assigned to."""

    __tablename__ = "classroom_groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)

    members: Mapped[list[ClassroomGroupMember]] = relationship(
        back_populates="group", cascade="all, delete-orphan"
    )


class ClassroomGroupMember(Base):
    __tablename__ = "classroom_group_members"

    group_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classroom_groups.id", ondelete="CASCADE"), primary_key=True
    )
    student_id: Mapped[str] = mapped_column(String(36), primary_key=True)

    group: Mapped[ClassroomGroup] = relationship(back_populates="members")


class Announcement(Base, TimestampMixin):
    """A Stream post (Google Classroom parity). ``attachments`` is a JSON list of
    ``{"type": "file"|"link", "url", "title"}``. A ``scheduled`` post becomes
    visible once its ``scheduled_for`` passes and it is published."""

    __tablename__ = "announcements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    author_name: Mapped[str | None] = mapped_column(String(160))
    title: Mapped[str | None] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    attachments: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="published", nullable=False, index=True)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (Index("ix_announcements_classroom_status", "classroom_id", "status"),)


COMMENT_VISIBILITIES = ("class", "private")


class Comment(Base, TimestampMixin):
    """A discussion comment — on the stream (``announcement_id``), on a coursework
    item (``coursework_id``), or a threaded reply (``parent_id``).

    Sprint 2, P3: ``submission_id`` + ``visibility`` add a second kind —
    a private teacher<->student note on one student's submission.
    ``visibility`` is never client-set directly (discussions.py derives it:
    ``submission_id`` present -> ``"private"``, matching the frozen invariant
    that only the submission's owner and the classroom's teachers may ever
    see a private comment). A reply always inherits its parent's
    ``submission_id``/``visibility`` rather than trusting its own request
    body, so a client cannot downgrade a private thread to public — or
    escalate a public one to private — by replying with different fields.
    """

    __tablename__ = "comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    author_name: Mapped[str | None] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    coursework_id: Mapped[str | None] = mapped_column(String(36), index=True)
    announcement_id: Mapped[str | None] = mapped_column(String(36), index=True)
    submission_id: Mapped[str | None] = mapped_column(String(36), index=True)
    visibility: Mapped[str] = mapped_column(String(20), default="class", nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36), index=True)
    mentions: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    reactions: Mapped[list[CommentReaction]] = relationship(
        back_populates="comment", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_comments_thread", "classroom_id", "coursework_id", "announcement_id"),
    )


class CommentReaction(Base):
    __tablename__ = "comment_reactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    comment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("comments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    comment: Mapped[Comment] = relationship(back_populates="reactions")

    __table_args__ = (
        UniqueConstraint("comment_id", "user_id", "emoji", name="uq_reaction_once"),
    )


class Rubric(Base, TimestampMixin):
    """A reusable grading rubric. ``criteria`` is a JSON list of
    ``{"criterion", "description", "maxPoints"}``."""

    __tablename__ = "rubrics"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    teacher_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    criteria: Mapped[list] = mapped_column(JSON, default=list, nullable=False)


class Guardian(Base, TimestampMixin):
    """A guardian↔student link. One row is both the invitation (``status='pending'``
    + ``token``) and the accepted link (``status='active'``).

    ``token`` started as an opaque ``secrets.token_urlsafe(24)`` value written
    on invite for an email-accept flow that was never built (see the module
    docstring's history). It is now the redeemable code a teacher shares
    directly with a guardian — regenerated via ``generate_guardian_code`` —
    short and human-typeable rather than a 32-character opaque string, and
    genuinely consumed by ``POST /api/lms/guardian/redeem``. ``code_expires_at``
    is new: a classroom join code is long-lived and reusable, but a guardian
    code is scoped to one student and must lapse."""

    __tablename__ = "guardians"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    student_name: Mapped[str | None] = mapped_column(String(160))
    guardian_email: Mapped[str] = mapped_column(String(255), nullable=False)
    guardian_user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False, index=True)
    token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    code_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invited_by: Mapped[str | None] = mapped_column(String(36))

    __table_args__ = (
        UniqueConstraint("student_id", "guardian_email", name="uq_guardian_student_email"),
    )


class Notification(Base):
    """In-app notification for one user (student / teacher / guardian)."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    data: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    # Opt-in, caller-supplied idempotency key (e.g. "due_soon:<courseworkId>"),
    # NULL for every notification type that doesn't need one. A unique
    # constraint on (user_id, dedupe_key) is the actual concurrency guard for
    # `todo.py`'s due-date notifications — the check-then-act SELECT that used
    # to be the only guard let two simultaneous /student/todo reads (a
    # double-tap, a client retry) both observe "not yet notified" and both
    # insert. NULL is never considered equal to NULL by a UNIQUE constraint in
    # either Postgres or SQLite, so this restricts only the rows that opt in
    # by supplying a key — every other notification type is unaffected.
    dedupe_key: Mapped[str | None] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_notifications_user_read", "user_id", "is_read"),
        UniqueConstraint("user_id", "dedupe_key", name="uq_notifications_user_dedupe_key"),
    )


class Upload(Base):
    """A teacher-uploaded file (Sprint 2, P2 / D5). Deliberately classroom-
    agnostic: a coursework or announcement's `attachments` JSON list only
    ever stores `{type: "file", url, title}` referencing this row's
    download URL, the same shape a "link" attachment already used — so
    uploading works exactly like typing a URL, just with a real backing
    file instead of an external one.

    `school_id` (not `classroom_id`) is the retrieval boundary — an upload
    isn't tied to one classroom (a teacher may attach it to several, or
    upload before the coursework it's meant for even exists), but it must
    never leak across a school boundary."""

    __tablename__ = "uploads"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    uploaded_by: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class GradeHistory(Base):
    """Append-only audit trail of every `grade_submission` call (Sprint 2,
    P3). `Submission.grade`/`feedback`/`rubric_scores` are mutable — a
    re-grade overwrites them with no record of what came before. This
    table is a new row per grading action, never updated or deleted, so a
    submission's full grading history (including re-grades before the
    first return) survives independently of that mutable state."""

    __tablename__ = "grade_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    submission_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    graded_by: Mapped[str] = mapped_column(String(36), nullable=False)
    grade: Mapped[float] = mapped_column(Numeric(6, 2), nullable=False)
    feedback: Mapped[str | None] = mapped_column(Text)
    rubric_scores: Mapped[list | None] = mapped_column(JSON, nullable=True)
    returned: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Phase 6.2 (refinement pass): distinguishes a reconstructed row
    # (backfill_grade_history.py, run once against submissions graded
    # before this table existed) from a real observation of a specific
    # grade_submission call. A backfilled row can only ever reflect a
    # submission's *current* state — there is no record of what an earlier
    # re-grade actually changed — so an audit-trail consumer needs to be
    # able to tell the two apart rather than have them silently mixed.
    is_backfilled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class CalendarEvent(Base, TimestampMixin):
    """A one-off classroom event — exam, field trip, parent-teacher meeting
    (Sprint 2, P4) — that exists independently of `Coursework.due_at`.
    `calendar_view.py`'s `/api/lms/calendar` merges these in alongside
    coursework due-dates.

    Deliberately **not** the same thing as `capability.ts`'s still-missing
    `lms.timetable` capability (a recurring weekly bell-schedule) — a
    one-off event and a recurring period are different shapes, and this
    table doesn't attempt the latter. Named here so a later session doesn't
    assume this closed that gap."""

    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    classroom_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_calendar_events_classroom_starts", "classroom_id", "starts_at"),
    )


class CurriculumVersion(Base, TimestampMixin):
    """Immutable published learning context. Owned by LMS, not the vector store."""
    __tablename__ = "curriculum_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    chapter_id: Mapped[str] = mapped_column(String(36), ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    school_id: Mapped[str] = mapped_column(String(36), index=True)
    document_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    concepts: Mapped[list] = mapped_column(JSON, default=list)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class QuizScoreReceipt(Base):
    __tablename__ = "quiz_score_receipts"
    attempt_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    coursework_id: Mapped[str] = mapped_column(String(36), nullable=False)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
