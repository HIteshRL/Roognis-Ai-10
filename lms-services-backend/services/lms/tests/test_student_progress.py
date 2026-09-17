"""Sprint 3, T4.1: GET /api/lms/student/progress — a student's own
progress, outside §13's teacher/parent-view restriction since it's the
student's own data and never a path parameter.
"""
from conftest import STUDENT_A


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def test_student_progress_never_takes_a_student_id(client, token_factory):
    """No route parameter or query param can redirect this at another
    student — it's always Depends(require_student)'s own JWT identity."""
    import inspect

    import todo

    sig = inspect.signature(todo.student_progress)
    assert "student_id" not in sig.parameters
    assert "studentId" not in sig.parameters


def test_student_progress_includes_class_averages(client, token_factory):
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
        json={"title": "HW1", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))

    # No grade yet — average is None, not omitted or zero.
    progress = client.get("/api/lms/student/progress", cookies=cookie(student)).json()
    assert progress["classAverages"] == [
        {"classroomId": classroom["id"], "classroomName": classroom["name"], "averagePercent": None}
    ]

    submit = client.post(
        f"/api/lms/coursework/{created['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    )
    assert submit.status_code == 201, submit.text
    submission_id = submit.json()["id"]

    client.post(
        f"/api/lms/submissions/{submission_id}/grade",
        json={"grade": 8, "returnToStudent": True},
        cookies=cookie(teacher),
    )

    progress = client.get("/api/lms/student/progress", cookies=cookie(student)).json()
    assert progress["classAverages"] == [
        {"classroomId": classroom["id"], "classroomName": classroom["name"], "averagePercent": 80.0}
    ]
    # Same due/overdue/graded shape as /student/todo, sharing the one
    # computation (student_progress_facts) both routes call.
    assert len(progress["recentlyGraded"]) == 1


def test_student_progress_average_withheld_until_returned(client, token_factory):
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
        json={"title": "HW1", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))
    submit = client.post(
        f"/api/lms/coursework/{created['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    )
    client.post(
        f"/api/lms/submissions/{submit.json()['id']}/grade",
        json={"grade": 8, "returnToStudent": False},
        cookies=cookie(teacher),
    )

    progress = client.get("/api/lms/student/progress", cookies=cookie(student)).json()
    assert progress["classAverages"][0]["averagePercent"] is None
