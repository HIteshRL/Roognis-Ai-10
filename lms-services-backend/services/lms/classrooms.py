"""Classroom / chapter / enrollment domain logic.

Ported from Roognis v2 `services/learner/classroom_service.py`, rewritten in the
direct-SQLAlchemy style used by main4's RAG service: functions take a `Session`
and the authenticated `AuthUser`, enforce school-scoping + teacher ownership,
and raise `HTTPException` on violations. Serializers emit camelCase to match the
Node services' JSON contract.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from auth import AuthUser
from models import (
    CLASSROOM_COLORS,
    Chapter,
    Classroom,
    Enrollment,
    EnrollmentRole,
    EnrollmentStatus,
    Term,
    generate_join_code,
)

_JOIN_CODE_MAX_ATTEMPTS = 6


# ── Serializers ──────────────────────────────────────────────────────────────

def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def serialize_classroom(classroom: Classroom, student_count: int, chapter_count: int) -> dict:
    return {
        "id": classroom.id,
        "schoolId": classroom.school_id,
        "teacherId": classroom.teacher_id,
        "termId": classroom.term_id,
        "name": classroom.name,
        "subject": classroom.subject,
        "section": classroom.section,
        "room": classroom.room,
        "grade": classroom.grade,
        "description": classroom.description,
        "color": classroom.color,
        "joinCode": classroom.join_code,
        "joinCodeEnabled": classroom.join_code_enabled,
        "isArchived": classroom.is_archived,
        "settings": classroom.settings or {},
        "studentCount": student_count,
        "chapterCount": chapter_count,
        "createdAt": _iso(classroom.created_at),
        "updatedAt": _iso(classroom.updated_at),
    }


def serialize_student_classroom(classroom: Classroom, chapter_count: int) -> dict:
    return {
        "id": classroom.id,
        "name": classroom.name,
        "subject": classroom.subject,
        "section": classroom.section,
        "grade": classroom.grade,
        "color": classroom.color,
        "teacherId": classroom.teacher_id,
        "termId": classroom.term_id,
        "chapterCount": chapter_count,
        "createdAt": _iso(classroom.created_at),
    }


def serialize_chapter(chapter: Chapter, document_count: int = 0) -> dict:
    return {
        "id": chapter.id,
        "classroomId": chapter.classroom_id,
        "knowledgeBaseId": chapter.knowledge_base_id,
        "title": chapter.title,
        "description": chapter.description,
        "orderIndex": chapter.order_index,
        "isPublished": chapter.is_published,
        "documentCount": document_count,
        "createdAt": _iso(chapter.created_at),
        "updatedAt": _iso(chapter.updated_at),
    }


def serialize_enrollment(enrollment: Enrollment) -> dict:
    return {
        "studentId": enrollment.student_id,
        "studentName": enrollment.student_name,
        "status": enrollment.status,
        "role": enrollment.role,
        "joinedAt": _iso(enrollment.joined_at),
    }


def serialize_co_teacher(enrollment: Enrollment) -> dict:
    return {
        "userId": enrollment.student_id,
        "name": enrollment.student_name,
        "joinedAt": _iso(enrollment.joined_at),
    }


# ── Counts ───────────────────────────────────────────────────────────────────

def count_students(db: Session, classroom_id: str) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Enrollment)
        .where(
            Enrollment.classroom_id == classroom_id,
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            Enrollment.role == EnrollmentRole.STUDENT.value,
        )
    ) or 0


def count_chapters(db: Session, classroom_id: str) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Chapter)
        .where(Chapter.classroom_id == classroom_id)
    ) or 0


def count_students_bulk(db: Session, classroom_ids: list[str]) -> dict[str, int]:
    """Batched form of count_students — one GROUP BY for the whole list
    instead of one query per classroom. A teacher with N classes previously
    cost 2N+1 queries just to render the class list (this plus
    count_chapters_bulk below bring it to 3)."""
    if not classroom_ids:
        return {}
    rows = db.execute(
        select(Enrollment.classroom_id, func.count())
        .where(
            Enrollment.classroom_id.in_(classroom_ids),
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            Enrollment.role == EnrollmentRole.STUDENT.value,
        )
        .group_by(Enrollment.classroom_id)
    ).all()
    counts = dict(rows)
    return {cid: counts.get(cid, 0) for cid in classroom_ids}


def count_chapters_bulk(db: Session, classroom_ids: list[str]) -> dict[str, int]:
    """Batched form of count_chapters — see count_students_bulk."""
    if not classroom_ids:
        return {}
    rows = db.execute(
        select(Chapter.classroom_id, func.count())
        .where(Chapter.classroom_id.in_(classroom_ids))
        .group_by(Chapter.classroom_id)
    ).all()
    counts = dict(rows)
    return {cid: counts.get(cid, 0) for cid in classroom_ids}


# ── Classroom lifecycle (teacher) ────────────────────────────────────────────

def unique_join_code(db: Session) -> str:
    for _ in range(_JOIN_CODE_MAX_ATTEMPTS):
        code = generate_join_code()
        exists = db.scalar(select(Classroom.id).where(Classroom.join_code == code))
        if not exists:
            return code
    return generate_join_code()


def get_school_term(db: Session, school_id: str, term_id: str) -> Term:
    term = db.scalar(select(Term).where(Term.id == term_id))
    if not term or term.school_id != school_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Term not found in your school.")
    return term


def create_classroom(db: Session, user: AuthUser, dto) -> Classroom:
    existing = db.scalar(
        select(func.count())
        .select_from(Classroom)
        .where(Classroom.teacher_id == user.user_id, Classroom.is_deleted.is_(False))
    ) or 0
    color = dto.color or CLASSROOM_COLORS[existing % len(CLASSROOM_COLORS)]

    term_id = getattr(dto, "term_id", None)
    if term_id:
        get_school_term(db, user.school_id, term_id)

    classroom = Classroom(
        school_id=user.school_id,
        teacher_id=user.user_id,
        term_id=term_id,
        name=dto.name,
        subject=dto.subject,
        section=dto.section,
        room=dto.room,
        grade=dto.grade,
        description=dto.description,
        color=color,
        join_code=unique_join_code(db),
        settings={"require_approval": bool(dto.require_approval)},
    )
    db.add(classroom)
    db.flush()
    return classroom


def list_teacher_classrooms(
    db: Session,
    user: AuthUser,
    *,
    only_archived: bool = False,
    term_id: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Classroom]:
    """Owner or active co-teacher — Sprint 1 shipped co-teachers who can
    grade, post, and be added/removed (membership.require_teacher_of admits
    them via is_active_co_teacher), but this listing only ever matched
    Classroom.teacher_id, so a co-teacher's own `/api/lms/classrooms` (and
    therefore their calendar, which derives its accessible-classroom set
    from this same function) came back empty — they could do everything
    except find the class.

    Sprint 4, P1: `limit`/`offset` are optional, same convention
    `list_coursework`/`list_enrollments` already use — every internal
    caller that wants the whole set (bulk-archive, the teacher to-do,
    calendar) keeps working unchanged; only the multi-course landing page
    (`GET /classrooms`) passes them, since it was the one list route in
    this service with no bound at all."""
    co_teacher_classroom_ids = select(Enrollment.classroom_id).where(
        Enrollment.student_id == user.user_id,
        Enrollment.status == EnrollmentStatus.ACTIVE.value,
        Enrollment.role == EnrollmentRole.CO_TEACHER.value,
    )
    query = select(Classroom).where(
        or_(
            Classroom.teacher_id == user.user_id,
            Classroom.id.in_(co_teacher_classroom_ids),
        ),
        Classroom.school_id == user.school_id,
        Classroom.is_deleted.is_(False),
        Classroom.is_archived.is_(only_archived),
    )
    if term_id:
        query = query.where(Classroom.term_id == term_id)
    query = query.order_by(Classroom.created_at.desc())
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


def list_student_classes_for_teacher(
    db: Session, user: AuthUser, student_id: str
) -> list[tuple[Classroom, Enrollment]]:
    """Sprint 3, P1: the classes ``student_id`` is actively enrolled in,
    intersected with the classes ``user`` teaches (owns or co-teaches) —
    the same owner-or-co-teacher test ``list_teacher_classrooms`` uses.

    Deliberately not a school-wide student directory: that belongs to
    ``auth_db``, not here. Scoping to the calling teacher's own classes is
    what stops this becoming a cross-classroom data leak — a teacher can
    look up a student they don't teach and get an empty list, not an error
    that confirms the student exists elsewhere in the school."""
    co_teacher_classroom_ids = select(Enrollment.classroom_id).where(
        Enrollment.student_id == user.user_id,
        Enrollment.status == EnrollmentStatus.ACTIVE.value,
        Enrollment.role == EnrollmentRole.CO_TEACHER.value,
    )
    query = (
        select(Classroom, Enrollment)
        .join(Enrollment, Enrollment.classroom_id == Classroom.id)
        .where(
            Enrollment.student_id == student_id,
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            Enrollment.role == EnrollmentRole.STUDENT.value,
            Classroom.school_id == user.school_id,
            Classroom.is_deleted.is_(False),
            or_(
                Classroom.teacher_id == user.user_id,
                Classroom.id.in_(co_teacher_classroom_ids),
            ),
        )
        .order_by(Classroom.name.asc())
    )
    return list(db.execute(query).all())


def update_classroom(db: Session, classroom: Classroom, dto) -> Classroom:
    for field_name in ("name", "subject", "section", "room", "grade", "description", "color"):
        value = getattr(dto, field_name)
        if value is not None:
            setattr(classroom, field_name, value)
    term_id = getattr(dto, "term_id", None)
    if term_id is not None:
        # Matches chapter_id/knowledge_base_id elsewhere in this file: a
        # PATCH field of None means "don't touch", not "clear" — there is
        # no clear-the-term action via this endpoint.
        classroom.term_id = get_school_term(db, classroom.school_id, term_id).id
    if dto.settings is not None:
        merged = dict(classroom.settings or {})
        if dto.settings.require_approval is not None:
            merged["require_approval"] = dto.settings.require_approval
        if dto.settings.stream_permission is not None:
            merged["stream_permission"] = dto.settings.stream_permission
        # Reassign rather than mutate in place — SQLAlchemy's JSON column
        # change-tracking needs a new object to detect the update.
        classroom.settings = merged
    db.flush()
    return classroom


def soft_delete_classroom(db: Session, classroom: Classroom) -> None:
    classroom.is_deleted = True
    db.flush()


def set_archived(db: Session, classroom: Classroom, archived: bool) -> Classroom:
    classroom.is_archived = archived
    db.flush()
    return classroom


def set_join_code_enabled(db: Session, classroom: Classroom, enabled: bool) -> Classroom:
    classroom.join_code_enabled = enabled
    db.flush()
    return classroom


def regenerate_join_code(db: Session, classroom: Classroom) -> Classroom:
    classroom.join_code = unique_join_code(db)
    db.flush()
    return classroom


# ── Chapters (teacher) ───────────────────────────────────────────────────────

def next_order_index(db: Session, classroom_id: str) -> int:
    current = db.scalar(
        select(func.max(Chapter.order_index)).where(Chapter.classroom_id == classroom_id)
    )
    return (current + 1) if current is not None else 0


def add_chapter(db: Session, classroom: Classroom, dto) -> Chapter:
    chapter = Chapter(
        classroom_id=classroom.id,
        school_id=classroom.school_id,
        title=dto.title,
        description=dto.description,
        knowledge_base_id=dto.knowledge_base_id,
        order_index=dto.order_index if dto.order_index is not None else next_order_index(db, classroom.id),
    )
    db.add(chapter)
    db.flush()
    return chapter


def list_chapters(db: Session, classroom_id: str, *, published_only: bool = False) -> list[Chapter]:
    query = select(Chapter).where(Chapter.classroom_id == classroom_id)
    if published_only:
        query = query.where(Chapter.is_published.is_(True))
    return list(db.scalars(query.order_by(Chapter.order_index.asc(), Chapter.created_at.asc())).all())


def get_owned_chapter(db: Session, user: AuthUser, chapter_id: str) -> Chapter:
    chapter = db.scalar(select(Chapter).where(Chapter.id == chapter_id))
    if not chapter or chapter.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found.")
    # Local import: membership.py imports from this module at module scope,
    # so a top-level import here would be circular.
    from membership import require_teacher_of

    # Confirms teacher ownership of the parent classroom.
    require_teacher_of(db, user, chapter.classroom_id)
    return chapter


def update_chapter(db: Session, chapter: Chapter, dto) -> Chapter:
    if dto.title is not None:
        chapter.title = dto.title
    if dto.description is not None:
        chapter.description = dto.description
    if dto.order_index is not None:
        chapter.order_index = dto.order_index
    if dto.is_published is not None:
        chapter.is_published = dto.is_published
    if dto.knowledge_base_id is not None:
        chapter.knowledge_base_id = dto.knowledge_base_id
    db.flush()
    return chapter


def delete_chapter(db: Session, chapter: Chapter) -> None:
    db.delete(chapter)
    db.flush()


# ── Enrollment ───────────────────────────────────────────────────────────────

def get_enrollment(db: Session, classroom_id: str, student_id: str) -> Enrollment | None:
    return db.scalar(
        select(Enrollment).where(
            Enrollment.classroom_id == classroom_id,
            Enrollment.student_id == student_id,
        )
    )


def is_enrolled(db: Session, classroom_id: str, student_id: str) -> bool:
    enrollment = get_enrollment(db, classroom_id, student_id)
    return bool(enrollment and enrollment.status == EnrollmentStatus.ACTIVE.value)


def is_active_co_teacher(db: Session, classroom_id: str, user_id: str) -> bool:
    enrollment = get_enrollment(db, classroom_id, user_id)
    return bool(
        enrollment
        and enrollment.status == EnrollmentStatus.ACTIVE.value
        and enrollment.role == EnrollmentRole.CO_TEACHER.value
    )


def list_enrollments(
    db: Session,
    classroom_id: str,
    *,
    status_filter: str | None = None,
    role_filter: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Enrollment]:
    # Sprint 3, S3.0.2: `limit`/`offset` are optional so every internal
    # caller (co-teacher lookups, membership checks) that wants the whole
    # set keeps working unchanged — only the two HTTP list routes
    # (roster, pending enrollments) pass them.
    query = select(Enrollment).where(Enrollment.classroom_id == classroom_id)
    if status_filter:
        query = query.where(Enrollment.status == status_filter)
    if role_filter:
        query = query.where(Enrollment.role == role_filter)
    query = query.order_by(Enrollment.joined_at.asc())
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


def join_by_code(db: Session, user: AuthUser, code: str) -> tuple[Classroom, str]:
    classroom = db.scalar(
        select(Classroom).where(Classroom.join_code == code.strip().upper())
    )
    if (
        not classroom
        # Join codes are unique service-wide, not per school, so without this
        # a code shared openly by one school enrolled anyone who typed it.
        # The enrollment row then carried the *joiner's* school_id, so they
        # showed up by name in the host school's roster, gradebook and
        # missing-work list, and inflated its assignedCount/missing stats.
        # 404 rather than 403, per the frozen contract: never confirm that a
        # resource exists in another school.
        or classroom.school_id != user.school_id
        or classroom.is_deleted
        or classroom.is_archived
        or not classroom.join_code_enabled
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No class found for that code.")

    existing = get_enrollment(db, classroom.id, user.user_id)
    if existing and existing.status == EnrollmentStatus.PENDING.value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Your join request is awaiting approval.")
    if existing and existing.status == EnrollmentStatus.ACTIVE.value:
        return classroom, existing.status

    requires_approval = bool((classroom.settings or {}).get("require_approval"))
    new_status = EnrollmentStatus.PENDING.value if requires_approval else EnrollmentStatus.ACTIVE.value

    if existing:
        existing.status = new_status
        existing.school_id = user.school_id
        if user.name:
            existing.student_name = user.name
    else:
        db.add(
            Enrollment(
                classroom_id=classroom.id,
                student_id=user.user_id,
                student_name=user.name or None,
                school_id=user.school_id,
                status=new_status,
            )
        )
    db.flush()
    return classroom, new_status


def approve_enrollment(db: Session, classroom_id: str, student_id: str) -> None:
    enrollment = get_enrollment(db, classroom_id, student_id)
    if not enrollment or enrollment.status != EnrollmentStatus.PENDING.value:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No pending request for that student.")
    enrollment.status = EnrollmentStatus.ACTIVE.value
    db.flush()


def reject_enrollment(db: Session, classroom_id: str, student_id: str) -> None:
    enrollment = get_enrollment(db, classroom_id, student_id)
    if not enrollment or enrollment.status != EnrollmentStatus.PENDING.value:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No pending request for that student.")
    db.delete(enrollment)
    db.flush()


def remove_student(db: Session, classroom_id: str, student_id: str) -> None:
    enrollment = get_enrollment(db, classroom_id, student_id)
    if not enrollment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student is not enrolled.")
    db.delete(enrollment)
    db.flush()


# ── Co-teachers ──────────────────────────────────────────────────────────────

def add_co_teacher(
    db: Session, classroom: Classroom, user_id: str, user_name: str | None
) -> Enrollment:
    if user_id == classroom.teacher_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That teacher already owns this class.",
        )
    existing = get_enrollment(db, classroom.id, user_id)
    if existing and existing.role == EnrollmentRole.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That teacher is enrolled as a student in this class.",
        )
    if existing and existing.status == EnrollmentStatus.ACTIVE.value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already a co-teacher of this class.")
    if existing:
        existing.status = EnrollmentStatus.ACTIVE.value
        existing.role = EnrollmentRole.CO_TEACHER.value
        if user_name:
            existing.student_name = user_name
        db.flush()
        return existing
    enrollment = Enrollment(
        classroom_id=classroom.id,
        student_id=user_id,
        student_name=user_name,
        school_id=classroom.school_id,
        status=EnrollmentStatus.ACTIVE.value,
        role=EnrollmentRole.CO_TEACHER.value,
    )
    db.add(enrollment)
    db.flush()
    return enrollment


def remove_co_teacher(db: Session, classroom_id: str, user_id: str) -> None:
    enrollment = get_enrollment(db, classroom_id, user_id)
    if not enrollment or enrollment.role != EnrollmentRole.CO_TEACHER.value:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a co-teacher of this class.")
    db.delete(enrollment)
    db.flush()


def list_student_classrooms(
    db: Session,
    user: AuthUser,
    *,
    term_id: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Classroom]:
    query = (
        select(Classroom)
        .join(Enrollment, Enrollment.classroom_id == Classroom.id)
        .where(
            Enrollment.student_id == user.user_id,
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            # The only classroom list that lacked a school filter (compare
            # list_teacher_classrooms). Defence in depth behind join_by_code's
            # own check: any enrollment rows already written by the
            # cross-school join hole stop surfacing the host school's
            # classrooms to the wrong student.
            Classroom.school_id == user.school_id,
            Classroom.is_deleted.is_(False),
            Classroom.is_archived.is_(False),
        )
        .order_by(Classroom.created_at.desc())
    )
    if term_id:
        query = query.where(Classroom.term_id == term_id)
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


# ── Student invitations (by email) ──────────────────────────────────────────

def add_student_by_email(db: Session, classroom: Classroom, user_id: str, user_name: str | None) -> Enrollment:
    """Enroll an existing student account directly by id, resolved from an
    email lookup (student_invitations.py). Mirrors add_co_teacher's shape,
    role=STUDENT, always ACTIVE — a teacher-initiated invite skips the
    join-code approval gate the same way approve/reject does once a teacher
    has already vetted the student by name."""
    existing = get_enrollment(db, classroom.id, user_id)
    if existing and existing.role == EnrollmentRole.CO_TEACHER.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That person is a co-teacher of this class.",
        )
    if existing and existing.status == EnrollmentStatus.ACTIVE.value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already enrolled in this class.")
    if existing:
        existing.status = EnrollmentStatus.ACTIVE.value
        if user_name:
            existing.student_name = user_name
        db.flush()
        return existing
    enrollment = Enrollment(
        classroom_id=classroom.id,
        student_id=user_id,
        student_name=user_name,
        school_id=classroom.school_id,
        status=EnrollmentStatus.ACTIVE.value,
        role=EnrollmentRole.STUDENT.value,
    )
    db.add(enrollment)
    db.flush()
    return enrollment


def require_enrolled(db: Session, user: AuthUser, classroom_id: str) -> Classroom:
    classroom = db.scalar(
        select(Classroom).where(Classroom.id == classroom_id, Classroom.is_deleted.is_(False))
    )
    if not classroom or classroom.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Classroom not found.")
    if not is_enrolled(db, classroom_id, user.user_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not enrolled in this class.")
    return classroom
