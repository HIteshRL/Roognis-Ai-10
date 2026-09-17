"""Student self-service progress view — `GET /student/todo`.

Shares its bucketing logic with `guardians.py::guardian_summary` (a parent's
read-only view of one linked child computing almost the exact same thing).
`student_progress_facts` is the single computation both routes call, so the
two consumers can't quietly drift apart the way two hand-copied queries
would.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import notifications as notify
import notification_types as ntype
from auth import AuthUser, require_student, require_teacher
from classrooms import list_student_classrooms, list_teacher_classrooms
from coursework import submission_stats_bulk, visible_coursework_filter
from database import get_db
from gradebook import build_missing_work_bulk, student_class_averages
from models import (
    Classroom,
    Coursework,
    CourseworkStatus,
    Enrollment,
    EnrollmentRole,
    EnrollmentStatus,
    Notification,
    Submission,
    SubmissionStatus,
)

router = APIRouter(prefix="/api/lms", tags=["todo"])

_NON_GRADEABLE = {"material"}
_UPCOMING_WINDOW_DAYS = 7


def _as_utc(value: datetime) -> datetime:
    # Same reasoning as stream.py/coursework.py's _as_utc: SQLite (tests)
    # drops tzinfo on read-back even for a DateTime(timezone=True) column;
    # Postgres doesn't. guardian_summary never had this guard before this
    # extraction — a latent gap, fixed as a side effect, not a new behavior.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _sort_by_due(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda e: e["dueAt"] or "")


def student_progress_facts(db: Session, student_id: str, school_id: str) -> dict:
    """One pass over a student's active classrooms and published, gradeable
    coursework, bucketed by submission state and due-date proximity.

    `later` (due beyond the 7-day window) is kept so guardians.py can
    reconstruct its original *unbounded* "upcoming" window by concatenating
    dueToday + upcoming + later — /student/todo drops `later` from its own
    response since a todo widget has no use for "someday" items.
    """
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(days=_UPCOMING_WINDOW_DAYS)

    due_today: list[dict] = []
    upcoming: list[dict] = []
    later: list[dict] = []
    overdue: list[dict] = []
    recently_submitted: list[dict] = []
    recently_graded: list[dict] = []

    classrooms = list(
        db.scalars(
            select(Classroom)
            .join(Enrollment, Enrollment.classroom_id == Classroom.id)
            .where(
                Enrollment.student_id == student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Classroom.school_id == school_id,
                Classroom.is_deleted.is_(False),
                Classroom.is_archived.is_(False),
            )
        ).all()
    )
    classroom_by_id = {c.id: c for c in classrooms}

    # Two batched queries instead of one-per-classroom/one-per-coursework-item
    # (the shape guardian_summary had before this extraction) — a student in
    # N classrooms with M coursework items each no longer costs N+M+1 queries.
    coursework_items = (
        list(
            db.scalars(
                select(Coursework).where(
                    Coursework.classroom_id.in_(classroom_by_id.keys()),
                    Coursework.status == CourseworkStatus.PUBLISHED.value,
                    # Sprint 3, C9: a targeted item that doesn't name this
                    # student must not appear in their due/overdue/missing
                    # buckets.
                    visible_coursework_filter(student_id),
                )
            ).all()
        )
        if classroom_by_id
        else []
    )
    coursework_ids = [cw.id for cw in coursework_items]
    submission_by_coursework_id = (
        {
            s.coursework_id: s
            for s in db.scalars(
                select(Submission).where(
                    Submission.coursework_id.in_(coursework_ids),
                    Submission.student_id == student_id,
                )
            ).all()
        }
        if coursework_ids
        else {}
    )

    for cw in coursework_items:
        if cw.type in _NON_GRADEABLE:
            continue
        classroom = classroom_by_id[cw.classroom_id]
        submission = submission_by_coursework_id.get(cw.id)
        entry = {
            "courseworkId": cw.id,
            "classroomId": classroom.id,
            "classroomName": classroom.name,
            "title": cw.title,
            "type": cw.type,
            "dueAt": cw.due_at.isoformat() if cw.due_at else None,
        }
        submitted = bool(
            submission
            and submission.status in (SubmissionStatus.TURNED_IN.value, SubmissionStatus.RETURNED.value)
        )
        if submitted and submission.status == SubmissionStatus.RETURNED.value:
            recently_graded.append(
                {
                    **entry,
                    "score": float(submission.grade) if submission.grade is not None else None,
                    "maxPoints": float(cw.max_points) if cw.max_points is not None else None,
                    "gradedAt": submission.graded_at.isoformat() if submission.graded_at else None,
                }
            )
        elif submitted:
            recently_submitted.append(
                {
                    **entry,
                    "turnedInAt": submission.turned_in_at.isoformat() if submission.turned_in_at else None,
                }
            )
        elif cw.due_at is None:
            continue  # No due date and not submitted — nothing to bucket (matches guardian_summary's prior silent drop).
        else:
            due_at = _as_utc(cw.due_at)
            if due_at < now:
                overdue.append(entry)
            elif due_at.date() == now.date():
                due_today.append(entry)
            elif due_at <= window_end:
                upcoming.append(entry)
            else:
                later.append(entry)

    recently_submitted.sort(key=lambda e: e.get("turnedInAt") or "", reverse=True)
    recently_graded.sort(key=lambda e: e.get("gradedAt") or "", reverse=True)

    return {
        "dueToday": _sort_by_due(due_today),
        "upcoming": _sort_by_due(upcoming),
        "later": _sort_by_due(later),
        "overdue": _sort_by_due(overdue),
        "recentlySubmitted": recently_submitted[:10],
        "recentlyGraded": recently_graded[:10],
        "generatedAt": now.isoformat(),
    }


def _dedupe_key(type_: str, coursework_id: str) -> str:
    return f"{type_}:{coursework_id}"


def _already_notified_keys(db: Session, user_id: str, keys: list[str]) -> set[str]:
    """One query for every dueToday/overdue entry's dedupe key at once,
    against the unique-constraint index on (user_id, dedupe_key). Replaces
    the old per-entry `_already_notified`, which loaded the student's *entire*
    notification history and filtered the JSON `data` blob in Python — once
    per bucket entry, so a student with 15 overdue items ran 15 unbounded
    SELECTs on every single /student/todo read, and the cost grew with the
    student's total notification count forever, not with the 15 items being
    checked."""
    if not keys:
        return set()
    rows = db.scalars(
        select(Notification.dedupe_key).where(
            Notification.user_id == user_id,
            Notification.dedupe_key.in_(keys),
        )
    ).all()
    return set(rows)


def _notify_due_soon_and_overdue(db: Session, user: AuthUser, facts: dict) -> None:
    """Sprint 2, P4: emits due_soon/overdue notifications as a side effect
    of reading /student/todo, reusing the buckets student_progress_facts
    already computed — no scheduler process, no new due-date math.
    `dueToday` is this route's definition of "due soon" (a same-day
    reminder); `overdue` is exactly what it says.

    De-duplication has two layers. `_already_notified_keys`'s single batched
    SELECT is a cheap pre-check that skips the common case (already notified,
    nothing changed since the last read) without an INSERT attempt. The
    actual correctness guarantee is `dedupe_key`'s unique constraint on
    (user_id, dedupe_key) (Phase 2.2): two concurrent reads can both pass the
    SELECT-based check before either has inserted — a real gap the endpoint's
    own docstring used to claim didn't exist — but only one of their inserts
    can succeed; the loser's constraint violation is caught inside
    notify.emit's savepoint and degrades to a silent no-op, same as any other
    fail-open notification failure.

    See the module docstring in notification_types.py for why this can only
    ever fire when the student actually opens their to-do, which is an
    accepted tradeoff, not a defect."""
    due_soon_keys = [_dedupe_key(ntype.DUE_SOON, e["courseworkId"]) for e in facts["dueToday"]]
    overdue_keys = [_dedupe_key(ntype.OVERDUE, e["courseworkId"]) for e in facts["overdue"]]
    already = _already_notified_keys(db, user.user_id, due_soon_keys + overdue_keys)

    for entry in facts["dueToday"]:
        key = _dedupe_key(ntype.DUE_SOON, entry["courseworkId"])
        if key not in already:
            notify.emit(
                db,
                user_id=user.user_id,
                school_id=user.school_id,
                type=ntype.DUE_SOON,
                title=f'Due today: {entry["title"]}',
                body=entry["classroomName"] or "",
                data={"classroomId": entry["classroomId"], "courseworkId": entry["courseworkId"]},
                dedupe_key=key,
            )
    for entry in facts["overdue"]:
        key = _dedupe_key(ntype.OVERDUE, entry["courseworkId"])
        if key not in already:
            notify.emit(
                db,
                user_id=user.user_id,
                school_id=user.school_id,
                type=ntype.OVERDUE,
                title=f'Overdue: {entry["title"]}',
                body=entry["classroomName"] or "",
                data={"classroomId": entry["classroomId"], "courseworkId": entry["courseworkId"]},
                dedupe_key=key,
            )


def _active_students(db: Session) -> list[tuple[str, str]]:
    """Distinct (student_id, school_id) pairs with at least one active
    student enrollment. `role == STUDENT` excludes co-teacher rows, which
    share the same `enrollments` table (models.py's `EnrollmentRole`) and
    have no due-date notifications of their own."""
    rows = db.execute(
        select(Enrollment.student_id, Enrollment.school_id)
        .where(
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            Enrollment.role == EnrollmentRole.STUDENT.value,
        )
        .distinct()
    ).all()
    return [(row.student_id, row.school_id) for row in rows]


def run_due_date_notification_sweep(db: Session) -> int:
    """The proactive counterpart to `_notify_due_soon_and_overdue`'s on-read
    firing: walks every active student and emits the same due_soon/overdue
    notifications `GET /student/todo` would, so a student who never opens
    the app still gets notified. Intended to be called on a timer (see
    `scheduler.py`), not from a request path.

    Reuses `student_progress_facts`/`_notify_due_soon_and_overdue` verbatim
    rather than re-deriving the bucketing — the two paths sharing one
    computation is what stops them from silently disagreeing about what
    counts as "due soon".

    Safe to run concurrently with itself or with `/student/todo` firing
    for the same student: the only side effect is a `dedupe_key`-guarded
    notification insert (Phase 2.2's unique constraint on
    `(user_id, dedupe_key)`), so a duplicate emit from an overlapping run
    fails the constraint and is absorbed by `notify.emit`'s savepoint,
    the same fail-open path any other notification failure takes. No
    claim-lease table is needed here the way `services/discover`'s
    `HuntRun` needs one for its scheduler (`hunt/run.js:87`) — a hunt is an
    external API call that is expensive and not safely repeatable, this
    sweep's only effect already tolerates repetition, and nothing in
    `docker-compose.yml` runs `lms` at more than one replica, so a second
    layer of coordination on top of the constraint isn't justified yet.

    Commits after each student rather than once at the end, so one
    student's failure can't roll back notifications already computed for
    students swept earlier in the same pass.

    Returns the number of students swept (not the number of notifications
    emitted — most sweeps emit zero, since a student with nothing newly due
    is the common case).
    """
    swept = 0
    for student_id, school_id in _active_students(db):
        user = AuthUser(user_id=student_id, role="student", school_id=school_id)
        facts = student_progress_facts(db, student_id, school_id)
        _notify_due_soon_and_overdue(db, user, facts)
        db.commit()
        swept += 1
    return swept


@router.get("/student/todo")
def student_todo(
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    facts = student_progress_facts(db, user.user_id, user.school_id)
    _notify_due_soon_and_overdue(db, user, facts)
    db.commit()
    return {
        "dueToday": facts["dueToday"],
        "upcoming": facts["upcoming"],
        "overdue": facts["overdue"],
        # Same predicate as `overdue` — exposed under both names since a
        # frontend may want a date-framed list ("Overdue") and a
        # catch-up-framed one ("Missing work") from the same data.
        "missing": facts["overdue"],
        "recentlySubmitted": facts["recentlySubmitted"],
        "recentlyGraded": facts["recentlyGraded"],
        "generatedAt": facts["generatedAt"],
    }


@router.get("/student/progress")
def student_progress(
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    """Sprint 3, T4.1: a student's own progress — outside §13's teacher/
    parent-view restriction entirely, since it is the student's own data
    and `user_id` comes from the JWT, never a path parameter (a
    `studentId` in the path is how this route would quietly become a
    teacher view by accident). Reuses `student_progress_facts` (already
    shared with `guardians.py::guardian_summary`) plus per-class averages,
    so this and the to-do read can never silently drift on what counts as
    overdue/missing/graded."""
    facts = student_progress_facts(db, user.user_id, user.school_id)
    classrooms = list_student_classrooms(db, user)
    averages = student_class_averages(db, user.user_id, user.school_id)
    return {
        "dueToday": facts["dueToday"],
        "upcoming": facts["upcoming"],
        "overdue": facts["overdue"],
        "recentlySubmitted": facts["recentlySubmitted"],
        "recentlyGraded": facts["recentlyGraded"],
        "classAverages": [
            {
                "classroomId": classroom.id,
                "classroomName": classroom.name,
                "averagePercent": averages.get(classroom.id),
            }
            for classroom in classrooms
        ],
        "generatedAt": facts["generatedAt"],
    }


def teacher_todo_facts(db: Session, user: AuthUser) -> dict:
    """Sprint 4, P4 (T4.1): the teacher-facing counterpart to
    `student_progress_facts` — "everything waiting on you," across every
    classroom the teacher owns or co-teaches, not just whichever one a
    dashboard happens to have focused. `list_teacher_classrooms` is already
    co-teacher-aware (Sprint 3 fixed the identical "co-teacher can grade but
    can't find their own class" gap in the student-facing list), so a
    co-teacher's own to-do already includes classes they don't own outright.

    This is coursework *metadata* — turned in / graded / withheld / draft /
    scheduled, and enrollment *status* (pending vs active) — sitting on the
    same side of the privacy line the already-shipped missing-work and
    gradebook routes sit on. It must never drift into inferring anything
    *about* a student: `riskRules.ts` remains the only intervention ruleset
    (decision D12), and nothing here reads a submission's content or a
    student's history beyond "did they turn this in."

    `coursework` deliberately includes *every* item regardless of status or
    type — draft, scheduled, published, even a published `material` with no
    `stats` (nothing to grade) — rather than pre-filtering to "has a
    signal." This single list is what lets the frontend derive both the
    dashboard's "today's schedule" (needs every classroom's due-today items,
    any status/type) and its pending-review counts (needs only published-
    gradeable items with a nonzero stat) from one fetch instead of two —
    the same division of labor `student_progress_facts` already has with
    its own caller: this function computes facts, the caller decides what
    counts as worth surfacing."""
    now = datetime.now(timezone.utc)
    classrooms = list_teacher_classrooms(db, user)
    classroom_by_id = {c.id: c for c in classrooms}
    classroom_ids = list(classroom_by_id.keys())

    coursework_items = (
        list(
            db.scalars(
                select(Coursework).where(Coursework.classroom_id.in_(classroom_ids))
            ).all()
        )
        if classroom_ids
        else []
    )
    gradeable_published = [
        item
        for item in coursework_items
        if item.status == CourseworkStatus.PUBLISHED.value and item.type not in _NON_GRADEABLE
    ]
    stats_by_id = submission_stats_bulk(db, gradeable_published) if gradeable_published else {}

    coursework_facts = []
    for item in coursework_items:
        classroom = classroom_by_id[item.classroom_id]
        coursework_facts.append(
            {
                "classroomId": classroom.id,
                "classroomName": classroom.name,
                "courseworkId": item.id,
                "title": item.title,
                "type": item.type,
                "status": item.status,
                "dueAt": item.due_at.isoformat() if item.due_at else None,
                "scheduledFor": item.scheduled_for.isoformat() if item.scheduled_for else None,
                "createdAt": item.created_at.isoformat() if item.created_at else None,
                "stats": stats_by_id.get(item.id),
            }
        )

    pending_enrollments = (
        [
            {
                "classroomId": classroom_id,
                "classroomName": classroom_by_id[classroom_id].name,
                "count": count,
            }
            for classroom_id, count in db.execute(
                select(Enrollment.classroom_id, func.count())
                .where(
                    Enrollment.classroom_id.in_(classroom_ids),
                    Enrollment.status == EnrollmentStatus.PENDING.value,
                    Enrollment.role == EnrollmentRole.STUDENT.value,
                )
                .group_by(Enrollment.classroom_id)
            ).all()
        ]
        if classroom_ids
        else []
    )

    return {
        "coursework": coursework_facts,
        "pendingEnrollments": pending_enrollments,
        "missingWork": build_missing_work_bulk(db, classroom_ids),
        "generatedAt": now.isoformat(),
    }


@router.get("/teacher/todo")
def teacher_todo(
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    return teacher_todo_facts(db, user)
