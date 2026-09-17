"""Tests for the notification scheduler (plan Phase 6.3): the sweep function
in todo.py that the asyncio loop in scheduler.py calls on a timer, and the
loop itself.
"""
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import scheduler
from conftest import SCHOOL_A, STUDENT_A, TEACHER_B
from database import SessionLocal
from models import Enrollment, EnrollmentStatus, Notification
from todo import _active_students, run_due_date_notification_sweep


def cookie(token):
    return {"jwt": token}


def make_class_with_student(client, teacher, student):
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    return classroom


def make_published_coursework(client, teacher, classroom, due_at):
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "dueAt": due_at},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    return coursework


def test_sweep_notifies_a_student_who_never_opens_the_app(client, token_factory):
    """The whole point of the scheduler: no request to /student/todo happens
    here at all — the sweep is the only thing that ever reads this student's
    due-today coursework."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    make_published_coursework(client, teacher, classroom, (now + timedelta(hours=2)).isoformat())

    db = SessionLocal()
    try:
        swept = run_due_date_notification_sweep(db)
    finally:
        db.close()
    assert swept == 1

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] == "due_soon") == 1


def test_sweep_running_twice_does_not_duplicate(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    make_published_coursework(client, teacher, classroom, (now - timedelta(days=1)).isoformat())

    db = SessionLocal()
    try:
        run_due_date_notification_sweep(db)
        run_due_date_notification_sweep(db)
    finally:
        db.close()

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] == "overdue") == 1


def test_sweep_skips_a_student_with_nothing_due(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    make_class_with_student(client, teacher, student)

    db = SessionLocal()
    try:
        swept = run_due_date_notification_sweep(db)
    finally:
        db.close()
    # Still swept (they're an active enrolled student) — just no notifications.
    assert swept == 1
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert notifs == []


def test_active_students_excludes_removed_enrollment(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    db = SessionLocal()
    try:
        enrollment = (
            db.query(Enrollment)
            .filter_by(classroom_id=classroom["id"], student_id=STUDENT_A)
            .one()
        )
        enrollment.status = EnrollmentStatus.REMOVED.value
        db.commit()

        pairs = _active_students(db)
    finally:
        db.close()
    assert (STUDENT_A, SCHOOL_A) not in pairs


def test_active_students_excludes_co_teachers(client, token_factory, monkeypatch):
    """A co-teacher is a row in the same `enrollments` table (models.py's
    EnrollmentRole.CO_TEACHER) — the sweep must not mistake them for a
    student with due-date notifications of their own."""
    import co_teachers

    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    monkeypatch.setattr(
        co_teachers.clients,
        "lookup_teacher_by_email",
        lambda *a, **k: {"userId": TEACHER_B, "name": "Co Teacher", "role": "teacher"},
    )
    add = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(teacher),
    )
    assert add.status_code in (200, 201), add.text

    db = SessionLocal()
    try:
        pairs = _active_students(db)
    finally:
        db.close()
    assert TEACHER_B not in {student_id for student_id, _ in pairs}


def test_run_forever_ticks_repeatedly_and_stops_cleanly_on_cancel(monkeypatch):
    calls = []

    async def fake_tick():
        calls.append(1)

    monkeypatch.setattr(scheduler, "_tick", fake_tick)

    async def drive():
        task = asyncio.create_task(scheduler.run_forever(0.01))
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(drive())
    assert len(calls) >= 2


def test_tick_survives_a_sweep_failure_without_raising(monkeypatch):
    def boom():
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(scheduler, "_run_sweep_sync", boom)

    # Must not raise — a failed tick degrades to a log line, same fail-open
    # contract as notify.emit itself.
    asyncio.run(scheduler._tick())


def test_tick_calls_the_real_sweep_via_a_thread(monkeypatch):
    calls = []
    monkeypatch.setattr(scheduler, "_run_sweep_sync", lambda: calls.append(1) or 0)

    asyncio.run(scheduler._tick())
    assert calls == [1]
