"""Sprint 3, S3.0.2: pagination caps on the highest-value unbounded list
routes. Confirms `limit` actually bounds the returned page, and — for the
submissions route specifically — that pagination never changes the
independently-computed `stats` denominators (Sprint 1 contract C2 / Sprint 3
C8)."""


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def join_students(client, classroom, students):
    for student in students:
        res = client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(student),
        )
        assert res.status_code == 200, res.text


def test_roster_limit_caps_the_page(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = [
        token_factory("student", user_id=f"s-{i:02d}-{'a' * 24}") for i in range(5)
    ]
    join_students(client, classroom, students)

    page = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students?limit=2",
        cookies=cookie(teacher),
    )
    assert page.status_code == 200, page.text
    assert len(page.json()["students"]) == 2

    full = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students",
        cookies=cookie(teacher),
    )
    assert len(full.json()["students"]) == 5


def test_submissions_pagination_does_not_move_the_denominator(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = [
        token_factory("student", user_id=f"t-{i:02d}-{'b' * 24}") for i in range(3)
    ]
    join_students(client, classroom, students)

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    )
    coursework_id = created.json()["id"]
    publish = client.post(
        f"/api/lms/coursework/{coursework_id}/publish", cookies=cookie(teacher)
    )
    assert publish.status_code == 200, publish.text

    for student in students:
        res = client.post(
            f"/api/lms/coursework/{coursework_id}/submit",
            json={"text": "done"},
            cookies=cookie(student),
        )
        assert res.status_code == 201, res.text

    page = client.get(
        f"/api/lms/coursework/{coursework_id}/submissions?limit=1",
        cookies=cookie(teacher),
    )
    assert page.status_code == 200, page.text
    body = page.json()
    assert len(body["submissions"]) == 1
    # The denominator describes the whole roster/coursework, not the page.
    assert body["stats"]["assignedCount"] == 3
    assert body["stats"]["turnedIn"] == 3


def test_classrooms_limit_caps_the_page(client, token_factory):
    """Sprint 4, P1: GET /classrooms had no limit at all despite being the
    multi-course landing page — the one list route in this service with no
    bound, until now."""
    teacher = token_factory("teacher")
    for i in range(5):
        make_classroom(client, teacher, name=f"Class {i}")

    page = client.get("/api/lms/classrooms?limit=2", cookies=cookie(teacher))
    assert page.status_code == 200, page.text
    assert len(page.json()["classrooms"]) == 2

    full = client.get("/api/lms/classrooms", cookies=cookie(teacher))
    assert len(full.json()["classrooms"]) == 5

    offset_page = client.get("/api/lms/classrooms?limit=2&offset=2", cookies=cookie(teacher))
    assert len(offset_page.json()["classrooms"]) == 2
    # Newest-first order (created_at desc) — the two pages don't overlap.
    first_ids = {c["id"] for c in page.json()["classrooms"]}
    second_ids = {c["id"] for c in offset_page.json()["classrooms"]}
    assert first_ids.isdisjoint(second_ids)
