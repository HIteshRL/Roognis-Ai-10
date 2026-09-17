from datetime import datetime, timedelta, timezone

from conftest import STUDENT_A, STUDENT_B


def cookie(token):
    return {"jwt": token}


def test_missing_work_lists_students_without_a_submission(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student", user_id=STUDENT_A)
    student_b = token_factory("student", user_id=STUDENT_B)
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student_a))
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student_b))

    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "dueAt": (now - timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student_a)
    )

    res = client.get(f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(teacher))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["totalMissing"] == 1
    assert len(body["items"]) == 1
    assert [s["studentId"] for s in body["items"][0]["missingStudents"]] == [STUDENT_B]


def test_not_yet_due_coursework_is_excluded(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Not due yet", "dueAt": (now + timedelta(days=3)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    res = client.get(f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(teacher)).json()
    assert res["items"] == []


def test_fully_submitted_coursework_is_excluded(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    now = datetime.now(timezone.utc)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "dueAt": (now - timedelta(hours=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    client.post(f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student))

    res = client.get(f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(teacher)).json()
    assert res["items"] == []
    assert res["totalMissing"] == 0


def test_material_type_is_excluded(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    now = datetime.now(timezone.utc)
    material = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Reading", "type": "material", "dueAt": (now - timedelta(days=1)).isoformat()},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{material['id']}/publish", cookies=cookie(teacher))

    res = client.get(f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(teacher)).json()
    assert res["items"] == []


def test_student_cannot_view_missing_work(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    res = client.get(f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(student))
    assert res.status_code == 403
