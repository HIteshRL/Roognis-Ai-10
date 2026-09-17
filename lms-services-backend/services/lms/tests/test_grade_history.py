from conftest import SCHOOL_B, STUDENT_A, STUDENT_B


def cookie(token):
    return {"jwt": token}


def setup_graded_submission(client, teacher, student):
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    ).json()
    return classroom, coursework, submission


def test_grading_records_a_history_entry(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)

    grade = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 7, "feedback": "Good start"},
        cookies=cookie(teacher),
    )
    assert grade.status_code == 200, grade.text

    history = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    )
    assert history.status_code == 200, history.text
    entries = history.json()["history"]
    assert len(entries) == 1
    assert entries[0]["grade"] == 7
    assert entries[0]["feedback"] == "Good start"
    assert entries[0]["gradedBy"]
    assert entries[0]["returned"] is True


def test_regrade_appends_not_overwrites(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)

    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 6, "feedback": "First pass", "returnToStudent": False},
        cookies=cookie(teacher),
    )
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 9, "feedback": "Actually, well done", "returnToStudent": True},
        cookies=cookie(teacher),
    )

    entries = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]
    assert [e["grade"] for e in entries] == [6, 9]
    assert entries[0]["returned"] is False
    assert entries[1]["returned"] is True


def test_bulk_grade_also_records_history(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)

    res = client.post(
        f"/api/lms/coursework/{coursework['id']}/grades",
        json={"grades": [{"submissionId": submission["id"], "grade": 8}]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text

    entries = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]
    assert [e["grade"] for e in entries] == [8]


def test_student_can_view_own_grade_history(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade", json={"grade": 7}, cookies=cookie(teacher)
    )

    res = client.get(f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(student))
    assert res.status_code == 200, res.text
    assert len(res.json()["history"]) == 1


def test_other_student_cannot_view_grade_history(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student", user_id=STUDENT_A)
    student_b = token_factory("student", user_id=STUDENT_B)
    classroom, coursework, submission = setup_graded_submission(client, teacher, student_a)
    client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student_b)
    )
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade", json={"grade": 7}, cookies=cookie(teacher)
    )

    res = client.get(f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(student_b))
    assert res.status_code == 403


def test_cross_school_teacher_gets_404(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade", json={"grade": 7}, cookies=cookie(teacher)
    )

    intruder = token_factory("teacher", school_id=SCHOOL_B)
    res = client.get(f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(intruder))
    assert res.status_code == 404


def test_ungraded_submission_has_empty_history(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_graded_submission(client, teacher, student)

    res = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    )
    assert res.status_code == 200
    assert res.json()["history"] == []
