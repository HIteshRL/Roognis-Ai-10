"""Sprint 3, T3.1 (the quiz bridge, decision D10): linking a `type ==
'quiz'` coursework item to an approved quiz in quiz_db. The Quiz Service
itself is stubbed via monkeypatch (matching test_classrooms.py's pattern
for the Auth Service co-teacher lookup) since this suite runs against
in-memory SQLite with no other services reachable.
"""
from conftest import SCHOOL_A


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def _stub_quiz(quiz_id="quiz-1", school_id=SCHOOL_A, status_="ready"):
    def _lookup(settings, quiz_id_arg):
        if quiz_id_arg != quiz_id:
            return None
        return {"id": quiz_id, "schoolId": school_id, "status": status_, "questionCount": 5, "title": "Chapter 4 Quiz"}

    return _lookup


def test_link_approved_quiz_succeeds(client, token_factory, monkeypatch):
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()

    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz())
    res = client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    assert res.json()["quizId"] == "quiz-1"


def test_link_unapproved_quiz_is_rejected(client, token_factory, monkeypatch):
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()

    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz(status_="pending_review"))
    res = client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400, res.text

    detail = client.get(f"/api/lms/coursework/{created['id']}", cookies=cookie(teacher)).json()
    assert detail["quizId"] is None


def test_link_quiz_from_another_school_is_404(client, token_factory, monkeypatch):
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()

    monkeypatch.setattr(
        coursework.clients, "lookup_quiz", _stub_quiz(school_id="99999999-9999-9999-9999-999999999999")
    )
    res = client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 404, res.text


def test_link_quiz_on_non_quiz_coursework_is_rejected(client, token_factory, monkeypatch):
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Regular HW", "type": "assignment", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()

    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz())
    res = client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400, res.text


def test_internal_quiz_access_unlinked_quiz(client, internal_headers):
    """Sprint 3, T3.2 / decision D11: a quiz nothing has linked reports
    linked: false — the Quiz Service must leave its pre-Sprint-3 behaviour
    (school-wide, unrestricted) unchanged for the common case of a chapter
    quiz opened from frontend/."""
    res = client.get(
        "/api/lms/internal/quiz-access",
        params={"quizId": "unlinked-quiz", "studentId": "irrelevant"},
        headers=internal_headers,
    )
    assert res.status_code == 200, res.text
    assert res.json() == {
        "linked": False,
        "allowed": False,
        "classroomId": None,
        "courseworkId": None,
        "maxPoints": None,
    }


def test_internal_quiz_access_linked_and_enrolled(client, token_factory, monkeypatch, internal_headers):
    import coursework

    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()
    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz())
    client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))

    from conftest import STUDENT_A

    allowed = client.get(
        "/api/lms/internal/quiz-access",
        params={"quizId": "quiz-1", "studentId": STUDENT_A},
        headers=internal_headers,
    ).json()
    assert allowed == {
        "linked": True,
        "allowed": True,
        "classroomId": classroom["id"],
        "courseworkId": created["id"],
        "maxPoints": 20.0,
    }

    # A student in a different classroom (never enrolled here) is denied,
    # not confirmed-not-found — the route still reports linked: true (it
    # is not this student's business whether the quiz exists) but
    # allowed: false.
    denied = client.get(
        "/api/lms/internal/quiz-access",
        params={"quizId": "quiz-1", "studentId": "not-enrolled-student"},
        headers=internal_headers,
    ).json()
    assert denied["linked"] is True
    assert denied["allowed"] is False


def test_internal_quiz_access_requires_token(client):
    res = client.get(
        "/api/lms/internal/quiz-access",
        params={"quizId": "x", "studentId": "y"},
    )
    assert res.status_code == 401


def _setup_linked_quiz(client, token_factory, monkeypatch, *, max_points=20):
    import coursework

    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": max_points},
        cookies=cookie(teacher),
    ).json()
    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz())
    client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))
    return teacher, student, classroom, created


def test_quiz_score_scales_into_submission_grade(client, token_factory, monkeypatch, internal_headers):
    from conftest import STUDENT_A

    teacher, student, classroom, created = _setup_linked_quiz(client, token_factory, monkeypatch, max_points=20)

    res = client.post(
        "/api/lms/internal/quiz-score",
        json={"quizId": "quiz-1", "studentId": STUDENT_A, "score": 6, "maxScore": 8, "attemptId": "att-1"},
        headers=internal_headers,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["graded"] is True
    assert body["grade"] == 15.0  # 6/8 * 20

    # Withheld from the student until the teacher returns it (Sprint 1,
    # T3.1's contract applies to a quiz-fed grade exactly the same as a
    # teacher-entered one).
    submissions = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()
    mine = next(s for s in submissions["submissions"] if s["courseworkId"] == created["id"])
    assert mine["grade"] is None
    assert mine["status"] != "returned"

    # The teacher sees it and can return it.
    teacher_view = client.get(
        f"/api/lms/coursework/{created['id']}/submissions", cookies=cookie(teacher)
    ).json()
    teacher_row = teacher_view["submissions"][0]
    assert teacher_row["grade"] == 15.0

    # graded_by isn't part of serialize_submission's contract — check the
    # sentinel directly, same pattern test_coursework.py uses for
    # DB-only assertions.
    from database import SessionLocal
    from models import Submission

    db = SessionLocal()
    try:
        row = db.query(Submission).filter(Submission.id == teacher_row["id"]).one()
        assert row.graded_by == "system:quiz"
    finally:
        db.close()


def test_quiz_score_on_unlinked_quiz_is_a_noop(client, internal_headers):
    res = client.post(
        "/api/lms/internal/quiz-score",
        json={"quizId": "no-such-quiz", "studentId": "whoever", "score": 5, "maxScore": 5},
        headers=internal_headers,
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"graded": False, "reason": "not_linked"}


def test_quiz_score_for_unenrolled_student_is_a_noop(client, token_factory, monkeypatch, internal_headers):
    teacher, student, classroom, created = _setup_linked_quiz(client, token_factory, monkeypatch)

    res = client.post(
        "/api/lms/internal/quiz-score",
        json={"quizId": "quiz-1", "studentId": "someone-never-enrolled", "score": 5, "maxScore": 5},
        headers=internal_headers,
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"graded": False, "reason": "not_applicable"}


def test_quiz_score_for_untargeted_student_is_a_noop(client, token_factory, monkeypatch, internal_headers):
    """A targeted quiz-linked assignment must not let an enrolled-but-
    unassigned student's attempt (however it happened) write a grade."""
    import coursework

    teacher = token_factory("teacher")
    targeted_student = token_factory("student")
    other_student = token_factory("student", user_id="55555555-aaaa-bbbb-cccc-111111111111")
    classroom = make_classroom(client, teacher)
    for tok in (targeted_student, other_student):
        client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(tok),
        )
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    from conftest import STUDENT_A

    targeted_id = STUDENT_A
    other_id = next(s["studentId"] for s in roster if s["studentId"] != STUDENT_A)

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()
    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz())
    client.post(
        f"/api/lms/coursework/{created['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": [targeted_id]},
        cookies=cookie(teacher),
    )

    res = client.post(
        "/api/lms/internal/quiz-score",
        json={"quizId": "quiz-1", "studentId": other_id, "score": 5, "maxScore": 5},
        headers=internal_headers,
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"graded": False, "reason": "not_applicable"}
