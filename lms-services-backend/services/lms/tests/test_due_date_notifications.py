from datetime import datetime, timedelta, timezone

import notifications as notify
from database import SessionLocal
from models import Notification


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


def test_due_today_triggers_due_soon_notification(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    make_published_coursework(client, teacher, classroom, (now + timedelta(hours=2)).isoformat())

    res = client.get("/api/lms/student/todo", cookies=cookie(student))
    assert res.status_code == 200, res.text

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] == "due_soon") == 1


def test_overdue_triggers_overdue_notification(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    make_published_coursework(client, teacher, classroom, (now - timedelta(days=1)).isoformat())

    client.get("/api/lms/student/todo", cookies=cookie(student))

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] == "overdue") == 1


def test_repeated_reads_do_not_duplicate_notifications(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    make_published_coursework(client, teacher, classroom, (now + timedelta(hours=2)).isoformat())

    client.get("/api/lms/student/todo", cookies=cookie(student))
    client.get("/api/lms/student/todo", cookies=cookie(student))
    client.get("/api/lms/student/todo", cookies=cookie(student))

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] == "due_soon") == 1


def test_submitted_work_does_not_notify(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = make_published_coursework(client, teacher, classroom, (now + timedelta(hours=2)).isoformat())
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    )

    client.get("/api/lms/student/todo", cookies=cookie(student))

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] in ("due_soon", "overdue")) == 0


def test_dedupe_key_survives_a_genuine_race_two_sessions_both_pass_the_precheck(client, token_factory):
    """test_repeated_reads_do_not_duplicate_notifications above only proves
    the *sequential* case — each read commits before the next one starts, so
    the check-then-act SELECT never actually races itself. This test forces
    the race the plan calls out (Phase 2.2): two sessions both run
    `_already_notified` and both see "not yet notified" *before* either has
    inserted — exactly what two /student/todo requests overlapping in time
    would produce — then both attempt to emit. Only one row may land; the
    unique constraint on (user_id, dedupe_key) is what makes that true rather
    than the SELECT-based check, which both sessions already passed."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = make_published_coursework(client, teacher, classroom, (now + timedelta(hours=2)).isoformat())

    student_id = None
    # Discover the student's user id the same way the route does — from the
    # to-do read itself isn't available directly, so decode it from the token
    # via a real API call's cookie round-trip instead of guessing shape.
    me = client.get("/api/lms/student/todo", cookies=cookie(student))
    assert me.status_code == 200

    # Clear whatever the read above already inserted, so this test starts
    # from a clean slate and isolates just the race.
    db_setup = SessionLocal()
    try:
        existing = db_setup.query(Notification).filter(Notification.type == "due_soon").all()
        for n in existing:
            student_id = n.user_id
            db_setup.delete(n)
        db_setup.commit()
    finally:
        db_setup.close()
    assert student_id, "expected the earlier read to have created a due_soon notification to key off of"

    db_a = SessionLocal()
    db_b = SessionLocal()
    try:
        dedupe_key = f"due_soon:{coursework['id']}"
        # Both sessions independently confirm "nothing recorded yet" — the
        # state two overlapping requests would each observe.
        assert db_a.query(Notification).filter_by(user_id=student_id, dedupe_key=dedupe_key).first() is None
        assert db_b.query(Notification).filter_by(user_id=student_id, dedupe_key=dedupe_key).first() is None

        notify.emit(
            db_a,
            user_id=student_id,
            school_id=classroom.get("schoolId") or "",
            type="due_soon",
            title="Due today: HW1",
            body="",
            data={"classroomId": classroom["id"], "courseworkId": coursework["id"]},
            dedupe_key=dedupe_key,
        )
        db_a.commit()

        # db_b's insert races the same key, without ever re-checking — this
        # is the loser of the race, and must be silently absorbed rather than
        # raising or creating a second row.
        notify.emit(
            db_b,
            user_id=student_id,
            school_id=classroom.get("schoolId") or "",
            type="due_soon",
            title="Due today: HW1",
            body="",
            data={"classroomId": classroom["id"], "courseworkId": coursework["id"]},
            dedupe_key=dedupe_key,
        )
        db_b.commit()
    finally:
        db_a.close()
        db_b.close()

    verify = SessionLocal()
    try:
        rows = verify.query(Notification).filter_by(user_id=student_id, dedupe_key=dedupe_key).all()
        assert len(rows) == 1, "the unique constraint must allow exactly one row for this dedupe key"
    finally:
        verify.close()


def test_no_due_date_no_notification(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "No due date"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    client.get("/api/lms/student/todo", cookies=cookie(student))

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert sum(1 for n in notifs if n["type"] in ("due_soon", "overdue")) == 0
