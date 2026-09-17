"""Gradebook — teacher grade matrix + CSV export (Google Classroom parity).

Read-only aggregation over published gradeable coursework and their submissions;
no schema of its own. Ported from v2 ``services/learner/gradebook_service.py``,
using the foundation's Submission.grade / status(returned) fields. Submissions
for the whole classroom are loaded in a single query (no N×M fan-out).
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

import classrooms as cr
import coursework as cw
from auth import AuthUser, get_current_user
from classrooms import list_enrollments
from database import get_db
from membership import require_teacher_of
from models import (
    Classroom,
    Coursework,
    CourseworkStatus,
    CourseworkTarget,
    CourseworkTargetMode,
    Enrollment,
    EnrollmentRole,
    EnrollmentStatus,
    Submission,
    SubmissionStatus,
)

router = APIRouter(prefix="/api/lms", tags=["gradebook"])

# Everything except reference "material" is gradeable in the foundation's type set.
_NON_GRADEABLE = {"material"}


def _num(value) -> float | None:
    return float(value) if value is not None else None


def _targeted_pairs(db: Session, items: list[Coursework]) -> set[tuple[str, str]]:
    """(coursework_id, student_id) pairs naming who a `target_mode ==
    'students'` item among `items` actually applies to. Sprint 3, C9 —
    one batched query for the whole gradebook/missing-work pass, not one
    per coursework item. An 'all' item never appears in the result; its
    caller treats absence-from-targeting as "not restricted", not "not
    applicable"."""
    ids = [cw.id for cw in items if cw.target_mode == CourseworkTargetMode.STUDENTS.value]
    if not ids:
        return set()
    rows = db.scalars(
        select(CourseworkTarget).where(CourseworkTarget.coursework_id.in_(ids))
    ).all()
    return {(t.coursework_id, t.student_id) for t in rows}


def build_gradebook(db: Session, classroom_id: str, *, sort_by: str = "name", order: str = "asc") -> dict:
    published = list(
        db.scalars(
            select(Coursework)
            .where(
                Coursework.classroom_id == classroom_id,
                Coursework.status == CourseworkStatus.PUBLISHED.value,
            )
            .order_by(Coursework.published_at.asc().nullslast(), Coursework.created_at.asc())
        ).all()
    )
    gradeable = [cw for cw in published if cw.type not in _NON_GRADEABLE]
    columns = [
        {
            "courseworkId": cw.id,
            "title": cw.title,
            "type": cw.type,
            "maxPoints": _num(cw.max_points),
            "dueAt": cw.due_at.isoformat() if cw.due_at else None,
        }
        for cw in gradeable
    ]

    submissions: dict[tuple[str, str], Submission] = {}
    if gradeable:
        rows = db.scalars(
            select(Submission).where(
                Submission.coursework_id.in_([cw.id for cw in gradeable])
            )
        ).all()
        for sub in rows:
            submissions[(sub.coursework_id, sub.student_id)] = sub

    targeted = _targeted_pairs(db, gradeable)

    students = list_enrollments(
        db, classroom_id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
    )
    result_rows: list[dict] = []
    for enrollment in students:
        cells: dict[str, dict] = {}
        earned = possible = 0.0
        for cw in gradeable:
            # Sprint 3, C9: a targeted item this student wasn't assigned
            # renders as a distinct "not_applicable" cell, never "missing"
            # — and is excluded from this student's average the same way a
            # "missing" cell already is (no `sub`, so `earned`/`possible`
            # are untouched either way; `continue` here just skips the
            # dead submission lookup for a pair that can't have one).
            if (
                cw.target_mode == CourseworkTargetMode.STUDENTS.value
                and (cw.id, enrollment.student_id) not in targeted
            ):
                cells[cw.id] = {"status": "not_applicable", "score": None, "returned": False}
                continue
            sub = submissions.get((cw.id, enrollment.student_id))
            cell = {"status": "missing", "score": None, "returned": False}
            if sub:
                cell["status"] = sub.status
                if sub.grade is not None:
                    cell["score"] = _num(sub.grade)
                    returned = sub.status == SubmissionStatus.RETURNED.value
                    cell["returned"] = returned
                    # A null-maxPoints item is excluded from both sides of the
                    # average, not just the denominator. grade_submission's
                    # own bound check is skipped for null max_points too, so
                    # a grade here has no fixed scale to average against —
                    # adding it to `earned` while adding 0 to `possible`
                    # (the previous behavior) could push averagePercent past
                    # 100, since one item's raw score was being averaged as
                    # if it were itself a percentage. The cell still shows
                    # the student's actual score either way.
                    if returned and cw.max_points is not None:
                        earned += float(sub.grade)
                        possible += float(cw.max_points)
            cells[cw.id] = cell
        average = round((earned / possible) * 100, 1) if possible else None
        result_rows.append(
            {
                "studentId": enrollment.student_id,
                "studentName": enrollment.student_name or "Student",
                "cells": cells,
                "averagePercent": average,
            }
        )

    reverse = order == "desc"
    if sort_by == "average":
        result_rows.sort(
            key=lambda r: (r["averagePercent"] is None, r["averagePercent"] or 0), reverse=reverse
        )
    else:
        result_rows.sort(key=lambda r: (r["studentName"] or "").lower(), reverse=reverse)

    averages = [r["averagePercent"] for r in result_rows if r["averagePercent"] is not None]
    return {
        "classroomId": classroom_id,
        "columns": columns,
        "rows": result_rows,
        "classAveragePercent": round(sum(averages) / len(averages), 1) if averages else None,
        "studentCount": len(students),
    }


@router.get("/classrooms/{classroom_id}/gradebook")
def get_gradebook(
    classroom_id: str,
    sort_by: Annotated[str, Query(alias="sortBy")] = "name",
    order: Annotated[str, Query()] = "asc",
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    return build_gradebook(db, classroom_id, sort_by=sort_by, order=order)


@router.get("/classrooms/{classroom_id}/class-facts")
def get_class_facts(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    classroom = require_teacher_of(db, user, classroom_id)
    return build_class_facts_snapshot(db, classroom)


@router.get("/classrooms/{classroom_id}/gradebook.csv")
def export_gradebook_csv(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    book = build_gradebook(db, classroom_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Student"] + [c["title"] for c in book["columns"]] + ["Average %"])
    for row in book["rows"]:
        line: list = [row["studentName"]]
        for col in book["columns"]:
            cell = row["cells"][col["courseworkId"]]
            line.append("" if cell["score"] is None else cell["score"])
        line.append("" if row["averagePercent"] is None else row["averagePercent"])
        writer.writerow(line)
    return PlainTextResponse(
        buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="gradebook-{classroom_id}.csv"'},
    )


def student_class_averages(db: Session, student_id: str, school_id: str) -> dict[str, float | None]:
    """Sprint 3, T4.1: a student's own average-percent per active class —
    the same formula each `build_gradebook` row uses (RETURNED submissions
    only; a null-`maxPoints` item excluded from both sides of the ratio),
    computed directly for one student rather than materialising the whole
    class matrix. Fetching the full gradebook here would both leak every
    other student's grades into a read this student's own progress view
    triggers, and cost a query per classroom for rows nobody asked for.
    Every classroom the student is actively in appears in the result, with
    `None` (not omitted) when they have nothing graded yet."""
    classroom_ids = [
        row[0]
        for row in db.execute(
            select(Classroom.id)
            .join(Enrollment, Enrollment.classroom_id == Classroom.id)
            .where(
                Enrollment.student_id == student_id,
                Enrollment.status == EnrollmentStatus.ACTIVE.value,
                Enrollment.role == EnrollmentRole.STUDENT.value,
                Classroom.school_id == school_id,
                Classroom.is_deleted.is_(False),
                Classroom.is_archived.is_(False),
            )
        ).all()
    ]
    result: dict[str, float | None] = {classroom_id: None for classroom_id in classroom_ids}
    if not classroom_ids:
        return result

    rows = db.execute(
        select(Coursework.classroom_id, Submission.grade, Coursework.max_points)
        .join(
            Submission,
            and_(
                Submission.coursework_id == Coursework.id,
                Submission.student_id == student_id,
                Submission.status == SubmissionStatus.RETURNED.value,
            ),
        )
        .where(
            Coursework.classroom_id.in_(classroom_ids),
            Coursework.status == CourseworkStatus.PUBLISHED.value,
            Coursework.type != "material",
            Coursework.max_points.is_not(None),
            Submission.grade.is_not(None),
        )
    ).all()

    totals: dict[str, tuple[float, float]] = {}
    for classroom_id, grade, max_points in rows:
        earned, possible = totals.get(classroom_id, (0.0, 0.0))
        totals[classroom_id] = (earned + float(grade), possible + float(max_points))

    for classroom_id, (earned, possible) in totals.items():
        result[classroom_id] = round((earned / possible) * 100, 1) if possible else None
    return result


RECENT_COURSEWORK_LIMIT = 10


def _coursework_sort_key(item: Coursework) -> datetime:
    # Newest-first: due date, else publication, else creation — the exact
    # ordering web/'s classFacts.ts::sortKey already uses, so the "recent
    # window" this endpoint picks matches what the frontend would have
    # picked fetching the same list itself.
    for value in (item.due_at, item.published_at, item.created_at):
        if value is not None:
            return value
    return datetime.min.replace(tzinfo=timezone.utc)


def build_class_facts_snapshot(
    db: Session, classroom: Classroom, *, recent_limit: int = RECENT_COURSEWORK_LIMIT
) -> dict:
    """Sprint 3, T4.2: the whole of web/'s `ClassSnapshot` — roster, full
    coursework list (with stats), the recent window's submissions, and the
    gradebook — built server-side in one set of batched queries. Collapses
    `loadClassSnapshot`'s 1+N fan-out (roster, coursework, gradebook, then
    up to `RECENT_COURSEWORK_LIMIT` more requests for submission detail)
    into one request.

    `buildClassFacts` (the pure derivation) is untouched — this returns
    exactly the shape it already consumes. Reuses `build_gradebook` and
    `coursework.submission_stats_bulk`'s own batching rather than a query
    per coursework item, the same discipline every other list route in
    this service already follows."""
    students = list_enrollments(
        db, classroom.id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
    )
    coursework_items = cw.list_coursework(db, classroom.id)
    stats_by_id = cw.submission_stats_bulk(db, coursework_items)

    window = sorted(
        (
            item
            for item in coursework_items
            if item.status == CourseworkStatus.PUBLISHED.value and item.type not in _NON_GRADEABLE
        ),
        key=_coursework_sort_key,
        reverse=True,
    )[:recent_limit]

    submissions_by_coursework: dict[str, list[Submission]] = {item.id: [] for item in window}
    if window:
        rows = db.scalars(
            select(Submission).where(Submission.coursework_id.in_([item.id for item in window]))
        ).all()
        for sub in rows:
            submissions_by_coursework[sub.coursework_id].append(sub)

    return {
        "classroom": cr.serialize_classroom(
            classroom, cr.count_students(db, classroom.id), cr.count_chapters(db, classroom.id)
        ),
        "students": [cr.serialize_enrollment(e) for e in students],
        "coursework": [
            cw.serialize_coursework(item, stats=stats_by_id[item.id]) for item in coursework_items
        ],
        "submissionsByCoursework": {
            coursework_id: [cw.serialize_submission(s) for s in subs]
            for coursework_id, subs in submissions_by_coursework.items()
        },
        "gradebook": build_gradebook(db, classroom.id),
        "detailedCourseworkIds": [item.id for item in window],
    }


def build_missing_work(db: Session, classroom_id: str) -> dict:
    """Sprint 2, P4 — teacher missing-work view: published, gradeable,
    **already-overdue** coursework, each with the roster students who
    still have no turned-in/returned submission. Deliberately narrower
    than a gradebook "missing" cell (which also flags not-yet-due work) —
    this is "who needs a nudge right now", not the whole matrix."""
    now = datetime.now(timezone.utc)
    # due_at < now and type != material both pushed into the query — this
    # used to pull *every* published, due-dated coursework item for the
    # classroom and discard the not-yet-due ones in a Python list
    # comprehension. The ix_coursework_classroom_due index (Phase 3.1) makes
    # this an index range scan instead of a full scan of the classroom's
    # coursework filtered client-side. `due_at < now` at the SQL level
    # matches the same comparison list_published_coursework's
    # `scheduled_for <= now` and stream.py's equivalent already make —
    # established, working precedent in this codebase for comparing an aware
    # Python datetime against this column type across both SQLite (tests)
    # and Postgres.
    overdue_coursework = list(
        db.scalars(
            select(Coursework).where(
                Coursework.classroom_id == classroom_id,
                Coursework.status == CourseworkStatus.PUBLISHED.value,
                Coursework.due_at.is_not(None),
                Coursework.due_at < now,
                Coursework.type != "material",
            )
        ).all()
    )

    students = list_enrollments(
        db, classroom_id, status_filter="active", role_filter=EnrollmentRole.STUDENT.value
    )

    submitted_by_coursework: dict[str, set[str]] = {}
    if overdue_coursework:
        rows = db.scalars(
            select(Submission).where(
                Submission.coursework_id.in_([cw.id for cw in overdue_coursework]),
                Submission.status.in_([SubmissionStatus.TURNED_IN.value, SubmissionStatus.RETURNED.value]),
            )
        ).all()
        for sub in rows:
            submitted_by_coursework.setdefault(sub.coursework_id, set()).add(sub.student_id)

    targeted = _targeted_pairs(db, overdue_coursework)

    items = []
    for cw in overdue_coursework:
        submitted_ids = submitted_by_coursework.get(cw.id, set())
        # Sprint 3, C9: a targeted item only nudges the students it was
        # actually assigned to — an untargeted student was never "missing"
        # this in the first place.
        roster = (
            [e for e in students if (cw.id, e.student_id) in targeted]
            if cw.target_mode == CourseworkTargetMode.STUDENTS.value
            else students
        )
        missing = [
            {"studentId": e.student_id, "studentName": e.student_name or "Student"}
            for e in roster
            if e.student_id not in submitted_ids
        ]
        if missing:
            items.append(
                {
                    "courseworkId": cw.id,
                    "title": cw.title,
                    "dueAt": cw.due_at.isoformat(),
                    "missingCount": len(missing),
                    "missingStudents": missing,
                }
            )
    items.sort(key=lambda i: i["dueAt"])

    return {
        "classroomId": classroom_id,
        "generatedAt": now.isoformat(),
        "items": items,
        "totalMissing": sum(i["missingCount"] for i in items),
    }


@router.get("/classrooms/{classroom_id}/missing-work")
def get_missing_work(
    classroom_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_teacher_of(db, user, classroom_id)
    return build_missing_work(db, classroom_id)


def build_missing_work_bulk(db: Session, classroom_ids: list[str]) -> dict:
    """Sprint 4, P4 (T4.1) — the cross-classroom generalisation of
    `build_missing_work`, for the teacher to-do. A real rewrite, not a
    parameter swap: `build_missing_work` bound one `classroom_id` to both
    the `Coursework` filter and the `list_enrollments` roster read, so
    spanning many classrooms means correlating the roster per item's own
    classroom instead — done here in Python (bucketing one roster query's
    rows by `classroom_id`) since a student's roster membership doesn't
    need its own SQL join through `Coursework` the way `assigned_count_bulk`
    /`submission_stats_bulk` do for targeted-item denominators.

    `_targeted_pairs` (C9) already takes an arbitrary item list with no
    classroom assumption baked in, so it needs no change here — the only
    two things that actually bound a scalar `classroom_id` were the
    `Coursework` query and the roster read, both fixed below."""
    now = datetime.now(timezone.utc)
    if not classroom_ids:
        return {"items": [], "totalMissing": 0, "generatedAt": now.isoformat()}

    overdue_coursework = list(
        db.scalars(
            select(Coursework).where(
                Coursework.classroom_id.in_(classroom_ids),
                Coursework.status == CourseworkStatus.PUBLISHED.value,
                Coursework.due_at.is_not(None),
                Coursework.due_at < now,
                Coursework.type != "material",
            )
        ).all()
    )
    if not overdue_coursework:
        return {"items": [], "totalMissing": 0, "generatedAt": now.isoformat()}

    classroom_names = dict(
        db.execute(select(Classroom.id, Classroom.name).where(Classroom.id.in_(classroom_ids))).all()
    )

    students_by_classroom: dict[str, list] = {}
    for enrollment in db.scalars(
        select(Enrollment).where(
            Enrollment.classroom_id.in_(classroom_ids),
            Enrollment.status == EnrollmentStatus.ACTIVE.value,
            Enrollment.role == EnrollmentRole.STUDENT.value,
        )
    ).all():
        students_by_classroom.setdefault(enrollment.classroom_id, []).append(enrollment)

    submitted_by_coursework: dict[str, set[str]] = {}
    rows = db.scalars(
        select(Submission).where(
            Submission.coursework_id.in_([cw.id for cw in overdue_coursework]),
            Submission.status.in_([SubmissionStatus.TURNED_IN.value, SubmissionStatus.RETURNED.value]),
        )
    ).all()
    for sub in rows:
        submitted_by_coursework.setdefault(sub.coursework_id, set()).add(sub.student_id)

    targeted = _targeted_pairs(db, overdue_coursework)

    items = []
    for cw in overdue_coursework:
        students = students_by_classroom.get(cw.classroom_id, [])
        submitted_ids = submitted_by_coursework.get(cw.id, set())
        roster = (
            [e for e in students if (cw.id, e.student_id) in targeted]
            if cw.target_mode == CourseworkTargetMode.STUDENTS.value
            else students
        )
        missing = [
            {"studentId": e.student_id, "studentName": e.student_name or "Student"}
            for e in roster
            if e.student_id not in submitted_ids
        ]
        if missing:
            items.append(
                {
                    "classroomId": cw.classroom_id,
                    "classroomName": classroom_names.get(cw.classroom_id, ""),
                    "courseworkId": cw.id,
                    "title": cw.title,
                    "dueAt": cw.due_at.isoformat(),
                    "missingCount": len(missing),
                    "missingStudents": missing,
                }
            )
    items.sort(key=lambda i: i["dueAt"])

    return {
        "items": items,
        "totalMissing": sum(i["missingCount"] for i in items),
        "generatedAt": now.isoformat(),
    }
