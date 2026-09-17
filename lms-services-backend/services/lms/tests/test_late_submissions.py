from datetime import datetime, timedelta, timezone

from test_coursework import cookie, setup_class_with_student


def test_submission_on_time_is_not_late(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "dueAt": (now + timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "On time."},
        cookies=cookie(student),
    ).json()
    assert submission["status"] == "turned_in"
    assert submission["isLate"] is False


def test_submission_after_due_at_is_late(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "dueAt": (now - timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Sorry, this is late."},
        cookies=cookie(student),
    ).json()
    assert submission["status"] == "turned_in"
    assert submission["isLate"] is True

    # The teacher's grading view carries the same flag.
    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"]
    assert submissions[0]["isLate"] is True

    # And the student's own submission list.
    my_subs = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()["submissions"]
    assert my_subs[0]["isLate"] is True


def test_no_due_date_is_never_late(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    assert coursework["dueAt"] is None
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Whenever."},
        cookies=cookie(student),
    ).json()
    assert submission["isLate"] is False


def test_saving_a_draft_never_counts_as_late(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "dueAt": (now - timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    draft = client.post(
        f"/api/lms/coursework/{coursework['id']}/save",
        json={"text": "Work in progress..."},
        cookies=cookie(student),
    ).json()
    assert draft["status"] == "draft"
    assert draft["isLate"] is False


def test_resubmission_is_evaluated_against_current_due_at(client, token_factory):
    """allow_resubmission defaults to True, so a second submit is possible.
    The first submit is on time; the resubmission happens after the due
    date passes, so it flips to late — is_late tracks the most recent
    turn-in, not the first one."""
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "dueAt": (now + timedelta(seconds=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    first = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "First try."},
        cookies=cookie(student),
    ).json()
    assert first["isLate"] is False

    # Push the due date into the past so the resubmission lands after it,
    # without needing to actually sleep past a real due date.
    from database import SessionLocal
    from models import Coursework

    with SessionLocal() as db:
        cw = db.get(Coursework, coursework["id"])
        cw.due_at = now - timedelta(days=1)
        db.commit()

    second = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Resubmitted."},
        cookies=cookie(student),
    ).json()
    assert second["isLate"] is True


def test_extending_due_date_does_not_retroactively_clear_lateness(client, token_factory):
    """Documented decision: is_late is a historical fact about the moment
    of turn-in, not a live property. A teacher granting an extension after
    a late submission was already made must not silently un-flag it."""
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "dueAt": (now - timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Late submission."},
        cookies=cookie(student),
    ).json()
    assert submission["isLate"] is True

    # Teacher extends the due date well into the future.
    updated = client.patch(
        f"/api/lms/coursework/{coursework['id']}",
        json={"dueAt": (now + timedelta(days=7)).isoformat()},
        cookies=cookie(teacher),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["dueAt"] is not None

    # The already-recorded submission is still flagged late.
    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"]
    assert submissions[0]["isLate"] is True
