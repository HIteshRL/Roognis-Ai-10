"""Tests for backfill_grade_history.py (plan Phase 6.2).

Submissions graded before migration 0009 existed have no grade_history row
at all — there's no API path that produces that state today (grade_submission
always writes a history row), so these tests simulate it the same way it
actually happened: writing directly to the Submission row via a raw session,
bypassing the grading endpoint entirely, exactly as legacy pre-0009 data
would look.
"""
from datetime import datetime, timedelta, timezone

from backfill_grade_history import run_backfill
from database import SessionLocal
from models import GradeHistory, Submission, SubmissionStatus


def cookie(token):
    return {"jwt": token}


def make_submission_without_history(client, teacher, student, *, status, grade=8, graded_by=None):
    """Turns in a submission via the real API, then hand-grades it by writing
    directly to the row — simulating a submission graded before grade_history
    existed, with no history row at all."""
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Legacy Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Pre-history HW", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    ).json()

    graded_at = datetime.now(timezone.utc) - timedelta(days=30)
    db = SessionLocal()
    try:
        row = db.get(Submission, submission["id"])
        row.grade = grade
        row.feedback = "Nice work"
        row.graded_by = graded_by
        row.graded_at = graded_at
        row.status = status
        db.commit()
    finally:
        db.close()

    return submission["id"], graded_at


def test_dry_run_reports_count_without_inserting(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    submission_id, _ = make_submission_without_history(
        client, teacher, student, status=SubmissionStatus.RETURNED.value
    )

    db = SessionLocal()
    try:
        count = run_backfill(db, apply=False)
        assert count == 1
        assert db.query(GradeHistory).filter_by(submission_id=submission_id).count() == 0
    finally:
        db.close()


def test_apply_inserts_a_row_with_returned_derived_from_current_status(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    returned_id, returned_graded_at = make_submission_without_history(
        client, teacher, student, status=SubmissionStatus.RETURNED.value, grade=9
    )
    withheld_id, _ = make_submission_without_history(
        client, teacher, student, status=SubmissionStatus.TURNED_IN.value, grade=6
    )

    db = SessionLocal()
    try:
        count = run_backfill(db, apply=True)
        assert count == 2

        returned_row = db.query(GradeHistory).filter_by(submission_id=returned_id).one()
        assert returned_row.returned is True
        assert returned_row.is_backfilled is True
        assert returned_row.grade == 9
        assert returned_row.feedback == "Nice work"
        # The historical grading time, not "now".
        assert abs((returned_row.created_at.replace(tzinfo=timezone.utc) - returned_graded_at).total_seconds()) < 2

        withheld_row = db.query(GradeHistory).filter_by(submission_id=withheld_id).one()
        assert withheld_row.returned is False, (
            "a submission not currently returned must backfill as not-returned, "
            "or Phase 1.1's withholding fix would have to hide a row this script just made"
        )
    finally:
        db.close()


def test_running_twice_does_not_duplicate(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    submission_id, _ = make_submission_without_history(
        client, teacher, student, status=SubmissionStatus.RETURNED.value
    )

    db = SessionLocal()
    try:
        first = run_backfill(db, apply=True)
        assert first == 1
        second = run_backfill(db, apply=True)
        assert second == 0
        assert db.query(GradeHistory).filter_by(submission_id=submission_id).count() == 1
    finally:
        db.close()


def test_a_submission_with_real_history_is_skipped(client, token_factory):
    """A submission graded through the real API already has a genuine
    grade_history row — the backfill must never add a second, competing one
    for it."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Modern Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Modern HW", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    ).json()
    graded = client.post(
        f"/api/lms/submissions/{submission['id']}/grade", json={"grade": 7}, cookies=cookie(teacher)
    )
    assert graded.status_code == 200, graded.text

    db = SessionLocal()
    try:
        count = run_backfill(db, apply=True)
        assert count == 0
        rows = db.query(GradeHistory).filter_by(submission_id=submission["id"]).all()
        assert len(rows) == 1
        assert rows[0].is_backfilled is False
    finally:
        db.close()


def test_ungraded_submissions_are_never_backfilled(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Ungraded Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Untouched HW", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    )

    db = SessionLocal()
    try:
        count = run_backfill(db, apply=True)
        assert count == 0
    finally:
        db.close()
