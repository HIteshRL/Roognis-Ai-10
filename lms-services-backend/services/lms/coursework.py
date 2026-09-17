"""Coursework + submission + grading logic.

Ported from Roognis v2 `services/learner/{coursework,submission,gradebook}_service.py`
into main4's direct-SQLAlchemy style. Teachers author coursework against a
classroom they own; enrolled students submit; teachers grade and return.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, exists, func, or_, select
from sqlalchemy.orm import Session

import clients
import notifications as notify
import notification_types as ntype
from auth import AuthUser
from classrooms import count_students, count_students_bulk, is_enrolled, list_enrollments, require_enrolled
from lifecycle import publish_due_scheduled
from membership import require_teacher_of
from timeutil import as_utc
from models import (
    ClassroomGroupMember,
    Coursework,
    CourseworkStatus,
    CourseworkTarget,
    CourseworkTargetMode,
    CourseworkType,
    Enrollment,
    EnrollmentRole,
    EnrollmentStatus,
    GradeHistory,
    Submission,
    SubmissionStatus,
)

_VALID_TYPES = {item.value for item in CourseworkType}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _num(value) -> float | None:
    return float(value) if value is not None else None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_late(due_at: datetime | None, turned_in_at: datetime) -> bool:
    """Lateness is computed once, at the moment of turn-in, against
    whatever `due_at` is at that instant — never left to be inferred later
    by comparing timestamps after the fact. A coursework item with no due
    date can never be late. Deliberately not recomputed if a teacher edits
    due_at afterward (see submit_coursework below): a submission that was
    on time when it was made stays on time, and one that was late stays
    late — "late" describes an event, not a live property of the row."""
    if due_at is None:
        return False
    # SQLite (tests) drops tzinfo on read-back even for a DateTime(timezone=True)
    # column, so due_at can come back naive while turned_in_at (freshly
    # constructed via _now()) is always aware — normalize both through the
    # shared helper rather than adding a sixth ad-hoc copy of this fix.
    return as_utc(turned_in_at) > as_utc(due_at)


def _sort_key(c: Coursework) -> tuple:
    # Mirrors the SQL ORDER BY in list_published_coursework, used to re-sort
    # in Python after a lazy publish flip (the SQL ordering ran pre-flip,
    # using the still-null published_at for a row that just became due).
    return (
        -(c.published_at.timestamp() if c.published_at else float("-inf")),
        -c.created_at.timestamp(),
    )


def _notify_students(db: Session, classroom, coursework: Coursework) -> None:
    student_ids = [
        e.student_id
        for e in list_enrollments(
            db, classroom.id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
        )
        if e.student_id != coursework.teacher_id
    ]
    if coursework.target_mode == CourseworkTargetMode.STUDENTS.value:
        # Sprint 3, C9: only the students this item was actually assigned
        # to get the "new work" notification — an untargeted student was
        # never going to see it in their classwork or to-do either.
        targeted_ids = {
            row[0]
            for row in db.execute(
                select(CourseworkTarget.student_id).where(
                    CourseworkTarget.coursework_id == coursework.id
                )
            ).all()
        }
        student_ids = [sid for sid in student_ids if sid in targeted_ids]
    notify.emit_many(
        db,
        user_ids=student_ids,
        school_id=classroom.school_id,
        type=ntype.COURSEWORK_PUBLISHED,
        title=f"New work in {classroom.name}",
        body=coursework.title,
        data={"classroomId": classroom.id, "courseworkId": coursework.id},
    )


def _publish_due_scheduled(db: Session, classroom, items: list[Coursework], now: datetime) -> None:
    """Lazily flip any `scheduled` coursework whose `scheduled_for` has
    passed — same no-scheduler-process pattern as stream.py's equivalent for
    Announcement (Sprint 1, T1.3). The manual publish_coursework() below
    fires the same _notify_students call (Sprint 1, T4.1) — the two paths
    share the notify call, not the claim logic.

    The actual claim-and-notify race is handled by lifecycle.py, shared with
    stream.py's copy: a plain attribute-assignment-then-flush let two
    concurrent readers of the same due-scheduled item both flip it and both
    notify the whole roster, since the read and the write weren't atomic."""
    publish_due_scheduled(
        db,
        Coursework,
        scheduled_value=CourseworkStatus.SCHEDULED.value,
        published_value=CourseworkStatus.PUBLISHED.value,
        items=items,
        now=now,
        notify_one=lambda c: _notify_students(db, classroom, c),
    )


# ── Serializers ──────────────────────────────────────────────────────────────

def serialize_coursework(
    coursework: Coursework,
    *,
    stats: dict | None = None,
    my_submission: Submission | None = None,
    include_my_submission: bool = False,
    for_student: bool = False,
) -> dict:
    payload = {
        "id": coursework.id,
        "classroomId": coursework.classroom_id,
        "chapterId": coursework.chapter_id,
        "schoolId": coursework.school_id,
        "teacherId": coursework.teacher_id,
        "type": coursework.type,
        "title": coursework.title,
        "description": coursework.description,
        "topic": coursework.topic,
        "topicId": coursework.topic_id,
        "maxPoints": _num(coursework.max_points),
        "dueAt": _iso(coursework.due_at),
        "status": coursework.status,
        "scheduledFor": _iso(coursework.scheduled_for),
        "publishedAt": _iso(coursework.published_at),
        "allowResubmission": coursework.allow_resubmission,
        "attachments": coursework.attachments or [],
        "rubricCriteria": coursework.rubric_criteria,
        "targetMode": coursework.target_mode,
        "quizId": coursework.quiz_id,
        "createdAt": _iso(coursework.created_at),
        "updatedAt": _iso(coursework.updated_at),
    }
    if stats is not None:
        payload["submissionStats"] = stats
    # Student views always carry the key (null when not yet submitted) so the
    # client can rely on it; teacher views omit it entirely.
    if include_my_submission or my_submission is not None:
        payload["mySubmission"] = (
            serialize_submission(my_submission, for_student=for_student)
            if my_submission is not None
            else None
        )
    return payload


def serialize_submission(submission: Submission, *, for_student: bool = False) -> dict:
    # Sprint 1, T3.1: a teacher grading with returnToStudent=false leaves
    # status at turned_in (not returned) precisely so the student can't see
    # it yet — withholding grade/feedback/rubricScores here is what actually
    # enforces that, since this serializer used to run unconditionally for
    # both teacher and student views.
    withhold = for_student and submission.status != SubmissionStatus.RETURNED.value
    return {
        "id": submission.id,
        "courseworkId": submission.coursework_id,
        "studentId": submission.student_id,
        "studentName": submission.student_name,
        "status": submission.status,
        "isLate": bool(submission.is_late),
        "content": submission.content or {},
        "grade": None if withhold else _num(submission.grade),
        "feedback": None if withhold else submission.feedback,
        "rubricScores": None if withhold else submission.rubric_scores,
        "turnedInAt": _iso(submission.turned_in_at),
        "gradedAt": _iso(submission.graded_at),
        "createdAt": _iso(submission.created_at),
        "updatedAt": _iso(submission.updated_at),
    }


# ── Coursework (teacher) ─────────────────────────────────────────────────────

def create_coursework(db: Session, user: AuthUser, classroom, dto) -> Coursework:
    work_type = dto.type if dto.type in _VALID_TYPES else CourseworkType.ASSIGNMENT.value

    chapter_id = None
    if dto.chapter_id:
        chapter_id = _validated_chapter_id(db, classroom.id, dto.chapter_id)

    status_value = CourseworkStatus.DRAFT.value
    scheduled_for = None
    if dto.scheduled_for:
        status_value = CourseworkStatus.SCHEDULED.value
        scheduled_for = dto.scheduled_for

    coursework = Coursework(
        classroom_id=classroom.id,
        chapter_id=chapter_id,
        school_id=user.school_id,
        teacher_id=user.user_id,
        type=work_type,
        title=dto.title,
        description=dto.description,
        topic=dto.topic,
        max_points=dto.max_points,
        due_at=dto.due_at,
        scheduled_for=scheduled_for,
        attachments=[a.model_dump() for a in dto.attachments] if dto.attachments else [],
        status=status_value,
        **({"allow_resubmission": dto.allow_resubmission} if dto.allow_resubmission is not None else {}),
    )
    db.add(coursework)
    db.flush()
    return coursework


def duplicate_coursework(
    db: Session,
    settings,
    user: AuthUser,
    source: Coursework,
    *,
    target_classroom_id: str | None = None,
    title: str | None = None,
) -> Coursework:
    """Sprint 4, P2 (T2.1 / decision D17): an ordinary draft copy — no new
    table, no `CourseworkTemplate`. "Reuse across my other section" is the
    same operation as "duplicate in place", just with a different target
    classroom; that's what makes cross-classroom copy the interesting case
    rather than a separate feature.

    Copies the fields a teacher actually retypes (title, description,
    topic, max_points, due_at, allow_resubmission, attachments,
    rubric_criteria). Resets everything that describes *this run* of the
    assignment: `status='draft'`, `published_at`/`scheduled_for=None`,
    `target_mode='all'` — a fresh draft has no submissions and no
    `CourseworkTarget` rows to carry over, so there is nothing to reset
    there, only nothing to copy.

    `chapter_id`/`topic_id` are classroom-scoped foreign keys and are
    dropped whenever the target classroom differs from the source's — a
    carried-over id would either point at a chapter/topic in a completely
    unrelated classroom or violate the FK outright once one is checked.
    `quiz_id` is re-validated against the Quiz Service every time (not just
    cross-classroom): the same D10 rule `link_quiz` enforces on write
    (`status == 'ready'`) applies here, since the source quiz may have been
    pulled or never approved since the original item was linked — dropped
    rather than carrying over a now-invalid reference."""
    target_classroom_id = target_classroom_id or source.classroom_id
    is_cross_classroom = target_classroom_id != source.classroom_id
    if is_cross_classroom:
        require_teacher_of(db, user, target_classroom_id)

    quiz_id = None
    if source.quiz_id:
        try:
            quiz = clients.lookup_quiz(settings, source.quiz_id)
        except clients.QuizServiceUnavailable:
            quiz = None
        if quiz and quiz.get("schoolId") == user.school_id and quiz.get("status") == "ready":
            quiz_id = source.quiz_id

    duplicate = Coursework(
        classroom_id=target_classroom_id,
        chapter_id=None if is_cross_classroom else source.chapter_id,
        topic_id=None if is_cross_classroom else source.topic_id,
        school_id=user.school_id,
        teacher_id=user.user_id,
        type=source.type,
        title=title or f"{source.title} (copy)",
        description=source.description,
        topic=source.topic,
        max_points=source.max_points,
        due_at=source.due_at,
        allow_resubmission=source.allow_resubmission,
        attachments=list(source.attachments or []),
        rubric_criteria=list(source.rubric_criteria) if source.rubric_criteria else None,
        quiz_id=quiz_id,
        status=CourseworkStatus.DRAFT.value,
    )
    db.add(duplicate)
    db.flush()
    return duplicate


def _validated_chapter_id(db: Session, classroom_id: str, chapter_id: str) -> str:
    from models import Chapter

    exists = db.scalar(
        select(Chapter.id).where(Chapter.id == chapter_id, Chapter.classroom_id == classroom_id)
    )
    if not exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chapter is not in this classroom.")
    return chapter_id


def get_owned_coursework(db: Session, user: AuthUser, coursework_id: str) -> Coursework:
    coursework = db.scalar(select(Coursework).where(Coursework.id == coursework_id))
    if not coursework or coursework.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Coursework not found.")
    require_teacher_of(db, user, coursework.classroom_id)
    return coursework


def update_coursework(db: Session, coursework: Coursework, dto) -> Coursework:
    if dto.title is not None:
        coursework.title = dto.title
    if dto.description is not None:
        coursework.description = dto.description
    if dto.topic is not None:
        coursework.topic = dto.topic
    if dto.max_points is not None:
        coursework.max_points = dto.max_points
    if dto.due_at is not None:
        coursework.due_at = dto.due_at
    if dto.scheduled_for is not None and coursework.status == CourseworkStatus.DRAFT.value:
        coursework.status = CourseworkStatus.SCHEDULED.value
        coursework.scheduled_for = dto.scheduled_for
    if dto.attachments is not None:
        coursework.attachments = [a.model_dump() for a in dto.attachments]
    if dto.chapter_id is not None:
        coursework.chapter_id = _validated_chapter_id(db, coursework.classroom_id, dto.chapter_id) if dto.chapter_id else None
    if dto.allow_resubmission is not None:
        coursework.allow_resubmission = dto.allow_resubmission
    db.flush()
    return coursework


def set_targets(
    db: Session,
    coursework: Coursework,
    *,
    target_mode: str,
    student_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
) -> None:
    """Sprint 3, T2.1/T2.4 (decision D9): replace this coursework item's
    target rows. `target_mode == 'all'` clears any existing targets.
    `'students'` resolves `student_ids` plus every current member of
    `group_ids` into one flat, de-duplicated set, written once — a group's
    membership changing later has no further effect on this coursework
    item, which is the whole point of resolving at call time rather than
    storing a live group reference."""
    db.execute(delete(CourseworkTarget).where(CourseworkTarget.coursework_id == coursework.id))
    coursework.target_mode = target_mode
    if target_mode != CourseworkTargetMode.STUDENTS.value:
        db.flush()
        return

    # Only an actively-enrolled student can be targeted — a stale group
    # selection or a removed student's id in the request body is dropped
    # rather than written, the same way a request-body school_id would be
    # (C7): the enrolled set, not the caller, decides who's reachable.
    enrolled_ids = {
        e.student_id
        for e in list_enrollments(
            db, coursework.classroom_id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
        )
    }

    # student_id -> source_group_id (None for an explicitly-listed student).
    # An explicit listing wins over group provenance if the same student
    # appears both ways — setdefault only fills the first entry.
    resolved: dict[str, str | None] = {}
    for student_id in student_ids or []:
        if student_id in enrolled_ids:
            resolved.setdefault(student_id, None)
    if group_ids:
        rows = db.execute(
            select(ClassroomGroupMember.group_id, ClassroomGroupMember.student_id).where(
                ClassroomGroupMember.group_id.in_(group_ids)
            )
        ).all()
        for group_id, student_id in rows:
            if student_id in enrolled_ids:
                resolved.setdefault(student_id, group_id)

    if not resolved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No enrolled student resolved from studentIds/groupIds — this would publish to nobody.",
        )

    for student_id, source_group_id in resolved.items():
        db.add(
            CourseworkTarget(
                coursework_id=coursework.id,
                student_id=student_id,
                school_id=coursework.school_id,
                source_group_id=source_group_id,
            )
        )
    db.flush()


def link_quiz(db: Session, settings, coursework: Coursework, quiz_id: str) -> Coursework:
    """Sprint 3, T3.1 (decision D10): link `coursework` (must already be
    `type == 'quiz'`) to an approved quiz in `quiz_db`. Validates against
    the Quiz Service's own internal endpoint before writing — an
    LMS-side-only school_id/status check would trust a caller-supplied
    claim about a row this service can't see. Only a `status == 'ready'`
    quiz may be linked: its questions are LLM-drafted, and `ready` is the
    one state where a teacher has actually reviewed the answer key
    (`POST /api/quiz/quizzes/:quizId/approve`)."""
    if coursework.type != CourseworkType.QUIZ.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only coursework of type 'quiz' can be linked to a quiz.",
        )
    try:
        quiz = clients.lookup_quiz(settings, quiz_id)
    except clients.QuizServiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not verify that quiz right now. Try again shortly.",
        ) from exc
    # 404 rather than a more specific status for either failure — same
    # convention as C7's cross-school guard: never confirm a resource
    # exists in another school by distinguishing "not found" from "wrong
    # school" in the response.
    if not quiz or quiz.get("schoolId") != coursework.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quiz not found.")
    if quiz.get("status") != "ready":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only an approved quiz (status 'ready') can be linked to coursework.",
        )
    coursework.quiz_id = quiz_id
    db.flush()
    return coursework


def record_quiz_score(
    db: Session, coursework: Coursework, *, student_id: str, score: float, max_score: float
) -> Submission | None:
    """Sprint 3, T3.3: feed one quiz attempt's score into
    `Submission.grade`. LMS scales and stores; it does not score —
    `services/quiz/lib/scoring.js` already produced a deterministic
    exact-match `score`/`max_score` before this is ever called, and no
    grading logic is duplicated here.

    Returns None (a no-op, not an error) when the coursework has nothing
    to scale against, or the student wasn't actually assigned this item —
    a stale or racing call must not create a submission for someone the
    item doesn't apply to. Routes through `grade_submission` so the
    `max_points` bound, the `GradeHistory` audit row and the
    `coursework_returned` notification path all behave exactly as they do
    for a teacher-entered grade. `returnToStudent` is always False here —
    the teacher still decides when the student sees it (Sprint 1 T3.1's
    withholding contract), a quiz score does not bypass that."""
    if coursework.max_points is None or max_score <= 0:
        return None
    if not is_enrolled(db, coursework.classroom_id, student_id):
        return None
    if not is_visible_to_student(db, coursework, student_id):
        return None

    grade_value = round(float(score) / float(max_score) * float(coursework.max_points), 2)

    submission = get_student_submission(db, coursework.id, student_id)
    if submission is None:
        turned_in_at = _now()
        submission = Submission(
            coursework_id=coursework.id,
            student_id=student_id,
            school_id=coursework.school_id,
            status=SubmissionStatus.TURNED_IN.value,
            content={"source": "quiz"},
            turned_in_at=turned_in_at,
            # Same rule as submit_coursework: a quiz attempt scored after
            # the coursework's due_at is late same as any other submission.
            is_late=_is_late(coursework.due_at, turned_in_at),
        )
        db.add(submission)
        db.flush()

    # A `graded_by` sentinel, not a real user id — GradeHistory.graded_by
    # is a bare String(36) with no FK, so this is legible in an audit
    # trail as "the system, not a teacher" without needing a schema
    # change. `is_backfilled` stays False: this is a real observation of
    # a real grading action, not a reconstruction.
    system_user = AuthUser(user_id="system:quiz", role="teacher", school_id=coursework.school_id)
    dto = SimpleNamespace(grade=grade_value, feedback=None, rubric_scores=None, return_to_student=False)
    return grade_submission(db, system_user, submission, coursework, dto)


def publish_coursework(db: Session, coursework: Coursework) -> Coursework:
    if coursework.status != CourseworkStatus.PUBLISHED.value:
        coursework.status = CourseworkStatus.PUBLISHED.value
        coursework.published_at = _now()
        db.flush()
        _notify_students(db, coursework.classroom, coursework)
    return coursework


def list_coursework(
    db: Session,
    classroom_id: str,
    *,
    status_filter: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Coursework]:
    query = select(Coursework).where(Coursework.classroom_id == classroom_id)
    if status_filter:
        query = query.where(Coursework.status == status_filter)
    query = query.order_by(Coursework.created_at.desc())
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


def assigned_count(db: Session, coursework: Coursework) -> int:
    """Frozen contract C8 (Sprint 3, T2.3): a coursework item's own
    assignment population — the whole active roster when `target_mode ==
    'all'`, or the count of targeted students who are still actively
    enrolled otherwise. Supersedes Sprint 1's C2, which took a single
    `roster_count` shared across every coursework item in a classroom;
    per-item targeting means each item can now have a different
    denominator, so this is no longer something a caller can compute once
    and pass in."""
    if coursework.target_mode != CourseworkTargetMode.STUDENTS.value:
        return count_students(db, coursework.classroom_id)
    return db.scalar(
        select(func.count())
        .select_from(CourseworkTarget)
        .join(
            Enrollment,
            and_(
                Enrollment.classroom_id == coursework.classroom_id,
                Enrollment.student_id == CourseworkTarget.student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
            ),
        )
        .where(CourseworkTarget.coursework_id == coursework.id)
    ) or 0


def assigned_count_bulk(db: Session, items: list[Coursework]) -> dict[str, int]:
    """Batched form of assigned_count — one shared roster count per
    classroom plus one GROUP BY for every targeted item, not one query per
    coursework row.

    Sprint 4, P4: `items` may now span an arbitrary set of classrooms (the
    teacher to-do's whole point) rather than always belonging to one caller-
    supplied `classroom_id` — the pre-P4 signature bound a single scalar
    `classroom_id` here, which every single-classroom call site happened to
    satisfy but which would have silently mis-scoped the roster join the
    moment a caller passed items from more than one classroom. Each item's
    own `classroom_id` is what the targeted-count join now correlates
    against (via a `Coursework` join), and the roster count is looked up
    per classroom via `count_students_bulk` — a single-classroom caller
    gets exactly the old behavior, just derived from `items` instead of a
    parameter, so no existing call site changes shape."""
    if not items:
        return {}
    classroom_ids = list({cw.classroom_id for cw in items})
    roster_counts = count_students_bulk(db, classroom_ids)
    targeted_ids = [cw.id for cw in items if cw.target_mode == CourseworkTargetMode.STUDENTS.value]
    targeted_counts: dict[str, int] = {}
    if targeted_ids:
        rows = db.execute(
            select(CourseworkTarget.coursework_id, func.count())
            .select_from(CourseworkTarget)
            .join(Coursework, Coursework.id == CourseworkTarget.coursework_id)
            .join(
                Enrollment,
                and_(
                    Enrollment.classroom_id == Coursework.classroom_id,
                    Enrollment.student_id == CourseworkTarget.student_id,
                    Enrollment.status == EnrollmentStatus.ACTIVE.value,
                    Enrollment.role == EnrollmentRole.STUDENT.value,
                ),
            )
            .where(CourseworkTarget.coursework_id.in_(targeted_ids))
            .group_by(CourseworkTarget.coursework_id)
        ).all()
        targeted_counts = dict(rows)
    return {
        cw.id: (
            targeted_counts.get(cw.id, 0)
            if cw.target_mode == CourseworkTargetMode.STUDENTS.value
            else roster_counts.get(cw.classroom_id, 0)
        )
        for cw in items
    }


def _stats_from_status_counts(
    by_status: dict[str, int], assigned: int, graded_not_returned: int = 0
) -> dict:
    """Sprint 1, T3.2 / frozen contract C2 (denominator source updated by
    Sprint 3's C8 — see assigned_count): `assigned` is this item's own
    assignment population, not necessarily the whole classroom roster. A
    `returned` submission was turned in at some point, so it's excluded
    from `missing` same as `turnedIn`. `draft` rows are never counted in
    `turnedIn`/`graded`, so by the `missing = assigned - turnedIn - graded`
    arithmetic below a student who has only saved a draft still counts as
    `missing` — correctly, since "missing" means "hasn't turned this in
    yet," and a draft in progress hasn't.

    Sprint 4, P3 (C2 amendment): `graded` here means "returned", not
    "graded" — a `returnToStudent=false` save leaves `status` at
    `turned_in`, so it can never show up via `by_status`. `graded_not_returned`
    is a second aggregate the caller computes over the same population
    (`grade IS NOT NULL AND status != 'returned'`), since it isn't derivable
    from status counts alone."""
    turned_in = by_status.get(SubmissionStatus.TURNED_IN.value, 0)
    graded = by_status.get(SubmissionStatus.RETURNED.value, 0)
    return {
        "assignedCount": assigned,
        "turnedIn": turned_in,
        "graded": graded,
        "gradedNotReturned": graded_not_returned,
        "missing": max(0, assigned - turned_in - graded),
    }


def submission_stats(db: Session, coursework: Coursework) -> dict:
    # Joined to the *current* active roster rather than counting every
    # Submission row for the coursework — a submission from a student who
    # has since been removed from the classroom used to still count toward
    # turnedIn/graded while assigned_count no longer includes them, so
    # turnedIn + graded could exceed assignedCount on screen. Both sides of
    # these stats now describe the same population. For a targeted item,
    # only targeted students could ever have submitted (T2.2's visibility
    # gate blocks anyone else from reaching submit), so this join does not
    # additionally need to intersect CourseworkTarget — only the
    # denominator (assigned_count, above) does.
    rows = db.execute(
        select(Submission.status, func.count())
        .join(
            Enrollment,
            and_(
                Enrollment.classroom_id == coursework.classroom_id,
                Enrollment.student_id == Submission.student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
            ),
        )
        .where(Submission.coursework_id == coursework.id)
        .group_by(Submission.status)
    ).all()
    by_status = {row[0]: row[1] for row in rows}
    graded_not_returned = db.scalar(
        select(func.count())
        .select_from(Submission)
        .join(
            Enrollment,
            and_(
                Enrollment.classroom_id == coursework.classroom_id,
                Enrollment.student_id == Submission.student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
            ),
        )
        .where(
            Submission.coursework_id == coursework.id,
            Submission.grade.isnot(None),
            Submission.status != SubmissionStatus.RETURNED.value,
        )
    ) or 0
    return _stats_from_status_counts(by_status, assigned_count(db, coursework), graded_not_returned)


def submission_stats_bulk(db: Session, items: list[Coursework]) -> dict[str, dict]:
    """Batched form of submission_stats — one GROUP BY over every id at once,
    not one query per item. A class with N assignments previously cost N+1
    queries (the list query plus one submission_stats call per row) to render
    its coursework list; this is 2 total, plus assigned_count_bulk's own
    (at most) 2. See submission_stats for why the submission join to the
    active roster is sufficient without also intersecting CourseworkTarget.

    Sprint 4, P4: generalised to span an arbitrary set of classrooms (the
    teacher to-do). The pre-P4 version joined `Enrollment` against a single
    scalar `classroom_id` parameter — every existing call site's `items`
    happened to all belong to one classroom, so it never surfaced, but nothing
    stopped a caller from passing items from many classrooms and getting every
    row silently checked against the wrong roster. The join now goes through
    `Coursework` so each submission's active-roster check correlates against
    *its own* item's classroom, not a single value handed in separately."""
    if not items:
        return {}
    coursework_ids = [cw.id for cw in items]
    rows = db.execute(
        select(Submission.coursework_id, Submission.status, func.count())
        .select_from(Submission)
        .join(Coursework, Coursework.id == Submission.coursework_id)
        .join(
            Enrollment,
            and_(
                Enrollment.classroom_id == Coursework.classroom_id,
                Enrollment.student_id == Submission.student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
            ),
        )
        .where(Submission.coursework_id.in_(coursework_ids))
        .group_by(Submission.coursework_id, Submission.status)
    ).all()
    by_coursework: dict[str, dict[str, int]] = {}
    for coursework_id, status_value, count in rows:
        by_coursework.setdefault(coursework_id, {})[status_value] = count
    gnr_rows = db.execute(
        select(Submission.coursework_id, func.count())
        .select_from(Submission)
        .join(Coursework, Coursework.id == Submission.coursework_id)
        .join(
            Enrollment,
            and_(
                Enrollment.classroom_id == Coursework.classroom_id,
                Enrollment.student_id == Submission.student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
            ),
        )
        .where(
            Submission.coursework_id.in_(coursework_ids),
            Submission.grade.isnot(None),
            Submission.status != SubmissionStatus.RETURNED.value,
        )
        .group_by(Submission.coursework_id)
    ).all()
    graded_not_returned_by_id = dict(gnr_rows)
    assigned_by_id = assigned_count_bulk(db, items)
    return {
        cw.id: _stats_from_status_counts(
            by_coursework.get(cw.id, {}),
            assigned_by_id[cw.id],
            graded_not_returned_by_id.get(cw.id, 0),
        )
        for cw in items
    }


# ── Coursework (student) ─────────────────────────────────────────────────────

def visible_coursework_filter(student_id: str):
    """Frozen contract C9 (Sprint 3, T2.2): the single predicate every
    student-visibility query applies. A `target_mode == 'all'` item is
    visible to every enrolled student; a `'students'` item is visible only
    to a student named by a `CourseworkTarget` row. No query site builds
    this join inline — see `HANDOFF.md`/`docs/SPRINT3_PLAN.md` for the list
    of call sites this must reach (list/get published coursework, to-do,
    calendar, gradebook, missing-work)."""
    return or_(
        Coursework.target_mode == CourseworkTargetMode.ALL.value,
        exists(
            select(CourseworkTarget.student_id).where(
                CourseworkTarget.coursework_id == Coursework.id,
                CourseworkTarget.student_id == student_id,
            )
        ),
    )


def is_visible_to_student(db: Session, coursework: Coursework, student_id: str) -> bool:
    """Row-already-in-hand form of `visible_coursework_filter`, for call
    sites (like `get_published_coursework_for_student`) that fetched the
    coursework by id and only need a yes/no rather than a query filter."""
    if coursework.target_mode == CourseworkTargetMode.ALL.value:
        return True
    return (
        db.scalar(
            select(CourseworkTarget.student_id).where(
                CourseworkTarget.coursework_id == coursework.id,
                CourseworkTarget.student_id == student_id,
            )
        )
        is not None
    )


def list_published_coursework(db: Session, classroom, student_id: str) -> list[Coursework]:
    now = _now()
    query = (
        select(Coursework)
        .where(
            Coursework.classroom_id == classroom.id,
            or_(
                Coursework.status == CourseworkStatus.PUBLISHED.value,
                and_(
                    Coursework.status == CourseworkStatus.SCHEDULED.value,
                    Coursework.scheduled_for <= now,
                ),
            ),
            visible_coursework_filter(student_id),
        )
        .order_by(Coursework.published_at.desc().nullslast(), Coursework.created_at.desc())
    )
    items = list(db.scalars(query).all())

    _publish_due_scheduled(db, classroom, items, now)
    items.sort(key=_sort_key)

    return items


def get_published_coursework_for_student(db: Session, user: AuthUser, coursework_id: str) -> Coursework:
    coursework = db.scalar(select(Coursework).where(Coursework.id == coursework_id))
    if (
        not coursework
        or coursework.school_id != user.school_id
        or coursework.status != CourseworkStatus.PUBLISHED.value
        or not is_visible_to_student(db, coursework, user.user_id)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Coursework not found.")
    require_enrolled(db, user, coursework.classroom_id)
    return coursework


def get_student_submission(db: Session, coursework_id: str, student_id: str) -> Submission | None:
    return db.scalar(
        select(Submission).where(
            Submission.coursework_id == coursework_id,
            Submission.student_id == student_id,
        )
    )


def get_student_submissions_bulk(
    db: Session, coursework_ids: list[str], student_id: str
) -> dict[str, Submission]:
    """Batched form of get_student_submission — one query for the whole list
    instead of one per item, the same shape todo.py's student_progress_facts
    already uses for this exact join."""
    if not coursework_ids:
        return {}
    return {
        s.coursework_id: s
        for s in db.scalars(
            select(Submission).where(
                Submission.coursework_id.in_(coursework_ids),
                Submission.student_id == student_id,
            )
        ).all()
    }


def submit_coursework(db: Session, user: AuthUser, coursework: Coursework, content: dict) -> Submission:
    """Note on due-date edits: `is_late` is computed here, once, against
    `coursework.due_at` as it stands at the moment of turn-in — it is not
    revisited if a teacher later changes `due_at` (update_coursework
    doesn't touch existing submissions, and nothing else recomputes this
    column). That's deliberate: a submission's lateness is a historical
    fact about when it was made relative to the due date that applied at
    the time, not a live property that should retroactively flip if the
    due date moves. A resubmission re-evaluates against the *current*
    due_at at the time of that resubmission, same as the first submit."""
    if coursework.type == CourseworkType.MATERIAL.value:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Material coursework cannot be submitted.")

    submission = get_student_submission(db, coursework.id, user.user_id)
    if submission and submission.status == SubmissionStatus.RETURNED.value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This submission has already been graded.")
    if (
        submission
        and submission.status == SubmissionStatus.TURNED_IN.value
        and not coursework.allow_resubmission
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resubmission is not allowed for this assignment.",
        )

    turned_in_at = _now()
    if submission:
        submission.content = content
        submission.status = SubmissionStatus.TURNED_IN.value
        submission.turned_in_at = turned_in_at
        submission.is_late = _is_late(coursework.due_at, turned_in_at)
        if user.name:
            submission.student_name = user.name
    else:
        submission = Submission(
            coursework_id=coursework.id,
            student_id=user.user_id,
            student_name=user.name or None,
            school_id=user.school_id,
            status=SubmissionStatus.TURNED_IN.value,
            content=content,
            turned_in_at=turned_in_at,
            is_late=_is_late(coursework.due_at, turned_in_at),
        )
        db.add(submission)
    db.flush()
    return submission


def save_draft(db: Session, user: AuthUser, coursework: Coursework, content: dict) -> Submission:
    """Save-as-draft (Sprint 1, T2.2 / contract C1). Same material-type and
    already-graded guards as submit_coursework, but never counts as turned
    in — submission_stats already excludes any status outside
    turned_in/returned/assigned from its counts, so a draft row is invisible
    to `turnedIn` with no further change needed there."""
    if coursework.type == CourseworkType.MATERIAL.value:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Material coursework cannot be submitted.")

    submission = get_student_submission(db, coursework.id, user.user_id)
    if submission and submission.status == SubmissionStatus.RETURNED.value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This submission has already been graded.")
    if (
        submission
        and submission.status == SubmissionStatus.TURNED_IN.value
        and not coursework.allow_resubmission
    ):
        # Same guard as submit_coursework's — without it, saving a draft
        # would flip status back to `draft`, and a later submit would no
        # longer see `turned_in` and so would bypass this exact check.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resubmission is not allowed for this assignment.",
        )

    if submission:
        submission.content = content
        submission.status = SubmissionStatus.DRAFT.value
        submission.turned_in_at = None
        # A saved-over draft isn't turned in at all, so it can't be late —
        # clears any is_late a previous turn-in had set, mirroring
        # turned_in_at's own reset just above.
        submission.is_late = False
        if user.name:
            submission.student_name = user.name
    else:
        submission = Submission(
            coursework_id=coursework.id,
            student_id=user.user_id,
            student_name=user.name or None,
            school_id=user.school_id,
            status=SubmissionStatus.DRAFT.value,
            content=content,
        )
        db.add(submission)
    db.flush()
    return submission


def list_student_submissions(
    db: Session, user: AuthUser, *, limit: int | None = None, offset: int = 0
) -> list[Submission]:
    query = (
        select(Submission)
        .where(Submission.student_id == user.user_id, Submission.school_id == user.school_id)
        .order_by(Submission.updated_at.desc())
    )
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


# ── Grading (teacher) ────────────────────────────────────────────────────────

def list_submissions(
    db: Session, coursework_id: str, *, limit: int | None = None, offset: int = 0
) -> list[Submission]:
    query = (
        select(Submission)
        .where(Submission.coursework_id == coursework_id)
        .order_by(Submission.turned_in_at.asc().nullslast(), Submission.created_at.asc())
    )
    if limit is not None:
        query = query.offset(offset).limit(limit)
    return list(db.scalars(query).all())


def get_owned_submission(db: Session, user: AuthUser, submission_id: str) -> tuple[Submission, Coursework]:
    submission = db.scalar(select(Submission).where(Submission.id == submission_id))
    if not submission or submission.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found.")
    coursework = get_owned_coursework(db, user, submission.coursework_id)
    return submission, coursework


def get_viewable_submission(db: Session, user: AuthUser, submission_id: str) -> tuple[Submission, Coursework]:
    """Either the classroom's teacher/co-teacher, or the submission's own
    student, may view it — used by the grade-history read (Sprint 2, P3),
    which unlike grading itself (get_owned_submission, teacher-only) a
    student needs too: it's an audit trail of their own grade."""
    submission = db.scalar(select(Submission).where(Submission.id == submission_id))
    if not submission or submission.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found.")
    coursework = db.scalar(select(Coursework).where(Coursework.id == submission.coursework_id))
    if not coursework:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found.")
    if submission.student_id != user.user_id:
        require_teacher_of(db, user, coursework.classroom_id)
    return submission, coursework


def _score_against_rubric(coursework: Coursework, rubric_scores) -> tuple[float, list[dict]]:
    """Sprint 1, T3.4: validate each score against the coursework's attached
    rubric criteria (keyed by `criterion`, bound by that criterion's own
    `maxPoints` — the camelCase key rubrics.py's by_alias dump actually
    stores) and sum for the computed grade. Raises 400 naming the bad
    criterion, matching grade_submission's own "name the offending thing"
    convention below."""
    criteria_by_name = {c["criterion"]: c for c in (coursework.rubric_criteria or [])}
    total = 0.0
    stored = []
    for item in rubric_scores:
        criterion = criteria_by_name.get(item.criterion)
        if not criterion:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{item.criterion}' is not a criterion on this coursework's rubric.",
            )
        if item.points > criterion["maxPoints"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Score for '{item.criterion}' cannot exceed {criterion['maxPoints']}.",
            )
        total += item.points
        stored.append({"criterion": item.criterion, "points": item.points})
    return total, stored


def grade_submission(
    db: Session,
    user: AuthUser,
    submission: Submission,
    coursework: Coursework,
    dto,
    *,
    defer_notify: list[tuple[Submission, Coursework]] | None = None,
) -> Submission:
    """`defer_notify`, when supplied (Sprint 4, P3's bulk-grading loop),
    collects `(submission, coursework)` instead of calling `_notify_returned`
    inline — the caller flushes once, then fires every collected
    notification through one `notify.emit_batch` savepoint rather than one
    `begin_nested()` per row. Single-submission callers omit it and keep
    the original per-row notify."""
    rubric_scores = None
    if getattr(dto, "rubric_scores", None):
        grade_value, rubric_scores = _score_against_rubric(coursework, dto.rubric_scores)
    else:
        grade_value = dto.grade

    if coursework.max_points is not None and grade_value > float(coursework.max_points):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Grade for submission {submission.id} "
                f"({submission.student_name or submission.student_id}) "
                f"exceeds maxPoints ({float(coursework.max_points)})."
            ),
        )
    was_returned = submission.status == SubmissionStatus.RETURNED.value
    submission.grade = grade_value
    # `None` means "not supplied, leave it alone" — the same convention
    # update_coursework and update_classroom already use for every optional
    # field. Assigning unconditionally silently wiped a teacher's per-criterion
    # rubric breakdown (and their feedback) on any later re-grade or bulk
    # grade, since bulk grading sends neither. The live row was the only place
    # that breakdown was read from; GradeHistory kept it, but no UI reads that.
    if dto.feedback is not None:
        submission.feedback = dto.feedback
    if rubric_scores is not None:
        submission.rubric_scores = rubric_scores
    submission.graded_by = user.user_id
    submission.graded_at = _now()
    if dto.return_to_student:
        submission.status = SubmissionStatus.RETURNED.value
    db.flush()
    # Sprint 2, P3: append-only audit row — submission.grade/feedback above
    # are mutable and get overwritten by the next grade_submission call, so
    # this is the only record of what a re-grade actually changed.
    db.add(
        GradeHistory(
            submission_id=submission.id,
            school_id=submission.school_id,
            graded_by=user.user_id,
            grade=grade_value,
            # The resulting state, not the raw request. Now that an omitted
            # feedback/rubric_scores preserves the previous value rather than
            # clearing it, recording the request would make each history row
            # read as though the teacher had blanked a field they never
            # touched. Every row is a self-consistent snapshot of the grade as
            # it stood after that call.
            feedback=submission.feedback,
            rubric_scores=submission.rubric_scores,
            returned=dto.return_to_student,
        )
    )
    # Notify only on the transition into `returned` — re-grading or editing
    # feedback on an already-returned submission must not re-notify (T4.1).
    if dto.return_to_student and not was_returned:
        if defer_notify is not None:
            defer_notify.append((submission, coursework))
        else:
            _notify_returned(db, submission, coursework)
    return submission


def serialize_grade_history_entry(entry: GradeHistory) -> dict:
    return {
        "id": entry.id,
        "submissionId": entry.submission_id,
        "gradedBy": entry.graded_by,
        "grade": _num(entry.grade),
        "feedback": entry.feedback,
        "rubricScores": entry.rubric_scores,
        "returned": entry.returned,
        # True only for a row backfill_grade_history.py manufactured from a
        # submission's current state (Phase 6.2) — never true for a row
        # written by grade_submission itself.
        "isBackfilled": entry.is_backfilled,
        "createdAt": _iso(entry.created_at),
    }


def list_grade_history(
    db: Session, submission_id: str, *, returned_only: bool = False
) -> list[GradeHistory]:
    """`returned_only` applies Sprint 1 T3.1's withholding contract to the audit
    trail. `serialize_grade_history_entry` carries the raw grade, so without
    this a student reading their own history (which get_viewable_submission
    deliberately permits) would see a grade the teacher saved with
    `returnToStudent=false` — the very value serialize_submission withholds
    from them two endpoints over.

    Entries are omitted rather than null-filled: a gap in an audit trail is
    honest, whereas a blanked row advertises that something was hidden and
    invites the reader to infer it."""
    query = select(GradeHistory).where(GradeHistory.submission_id == submission_id)
    if returned_only:
        query = query.where(GradeHistory.returned.is_(True))
    return list(db.scalars(query.order_by(GradeHistory.created_at.asc())).all())


def _return_notification_payload(submission: Submission, coursework: Coursework) -> dict:
    """The `emit`/`emit_batch` kwargs for a `coursework_returned`
    notification. Pulled out of `_notify_returned` so the single-row path
    (`grade_submission`) and the batched path (`bulk_grade_submissions`)
    build the identical payload from one place — a second hand-copied
    version of this is exactly the kind of drift `withholding.ts`'s
    frontend docstring warns against."""
    return {
        "user_id": submission.student_id,
        # Uses coursework.school_id directly (a denormalized column
        # already on Coursework) rather than needing a Classroom object.
        "school_id": coursework.school_id,
        "type": ntype.COURSEWORK_RETURNED,
        "title": f"Grade returned: {coursework.title}",
        "body": (
            f"You scored {_num(submission.grade)}"
            + (f"/{_num(coursework.max_points)}" if coursework.max_points is not None else "")
        ),
        "data": {
            "classroomId": coursework.classroom_id,
            "courseworkId": coursework.id,
            "submissionId": submission.id,
        },
    }


def _notify_returned(db: Session, submission: Submission, coursework: Coursework) -> None:
    notify.emit(db, **_return_notification_payload(submission, coursework))


def bulk_grade_submissions(
    db: Session, user: AuthUser, coursework: Coursework, items, return_to_student: bool
) -> list[Submission]:
    """Sprint 1, T3.3. Bulk-fetches the requested rows scoped to this
    coursework in one query (not get_owned_submission per row — that
    re-derives classroom ownership on every call, wasted work for N rows of
    an already-known-owned coursework). Loops grade_submission per row;
    since that only ever flushes (never commits), an exception on a bad row
    rolls back everything flushed so far when the caller's session closes
    without committing — "one transaction" with no extra bookkeeping.

    Sprint 4, P3: rejects rubric-graded coursework outright rather than
    accepting a `rubricScores` this endpoint has no field for. Before this
    guard, `grade_submission` was called with `rubric_scores=None`, which
    its own `None`-means-"leave it alone" convention (see that function's
    comment) preserved the *previous* per-criterion breakdown while
    replacing the flat `grade` — a bulk grade on rubric-graded work quietly
    made the two disagree. The bulk lane's semantics are "same value, many
    students"; a shared rubric breakdown was never meaningful here, so this
    is a rejection, not a feature gap."""
    if coursework.rubric_criteria:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This coursework is graded against a rubric — grade its submissions individually.",
        )

    ids = [item.submission_id for item in items]
    submissions_by_id = {
        s.id: s
        for s in db.scalars(
            select(Submission).where(
                Submission.id.in_(ids),
                Submission.coursework_id == coursework.id,
            )
        ).all()
    }
    graded: list[Submission] = []
    # Sprint 4, P3: collected here instead of notifying per row inside
    # grade_submission — see emit_batch's docstring for why one savepoint
    # for the whole batch is the right shape for this call site.
    pending_notifications: list[tuple[Submission, Coursework]] = []
    for item in items:
        submission = submissions_by_id.get(item.submission_id)
        if not submission:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Submission {item.submission_id} not found in this coursework.",
            )
        row_dto = SimpleNamespace(
            grade=item.grade,
            feedback=item.feedback,
            return_to_student=return_to_student,
            rubric_scores=None,
        )
        grade_submission(db, user, submission, coursework, row_dto, defer_notify=pending_notifications)
        graded.append(submission)

    db.flush()
    if pending_notifications:
        notify.emit_batch(
            db,
            [_return_notification_payload(sub, cw) for sub, cw in pending_notifications],
        )
    return graded


def return_all_graded(db: Session, user: AuthUser, coursework: Coursework) -> list[Submission]:
    """Flips every graded-but-not-yet-returned submission to returned and
    notifies each student. Ungraded submissions are untouched — nothing to
    return.

    Sprint 4, P3 (frozen contract C13 / Trap C): this used to flip `status`
    with no `GradeHistory` row at all, so `list_grade_history`'s
    `returned_only` filter (`returned IS TRUE`) hid the very event that
    revealed the grade — a student whose grade came back via this button
    saw an *empty* history. Writes one row per submission, same shape as
    `grade_submission`'s own audit row (`is_backfilled=False`): a submission
    saved withheld then bulk-returned correctly ends up with *two* rows,
    since two things happened to it."""
    submissions = list(
        db.scalars(
            select(Submission).where(
                Submission.coursework_id == coursework.id,
                Submission.grade.isnot(None),
                Submission.status != SubmissionStatus.RETURNED.value,
            )
        ).all()
    )
    for submission in submissions:
        submission.status = SubmissionStatus.RETURNED.value
        db.add(
            GradeHistory(
                submission_id=submission.id,
                school_id=submission.school_id,
                graded_by=user.user_id,
                grade=submission.grade,
                feedback=submission.feedback,
                rubric_scores=submission.rubric_scores,
                returned=True,
            )
        )
    db.flush()
    for submission in submissions:
        _notify_returned(db, submission, coursework)
    return submissions
