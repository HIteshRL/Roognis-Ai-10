"""Sprint 3, P1: roster operations at scale — bulk archive, a
teacher-scoped student-class lookup, bulk roster add/remove, and student
readable terms.
"""
from conftest import STUDENT_A, STUDENT_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def test_bulk_archive_by_ids(client, token_factory):
    teacher = token_factory("teacher")
    c1 = make_classroom(client, teacher, name="Class A")
    c2 = make_classroom(client, teacher, name="Class B")

    res = client.post(
        "/api/lms/classrooms/bulk-archive",
        json={"classroomIds": [c1["id"], c2["id"]]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["archived"]) == {c1["id"], c2["id"]}
    assert body["skipped"] == []

    listed = client.get("/api/lms/classrooms", cookies=cookie(teacher)).json()["classrooms"]
    assert listed == []  # archived classes don't show in the default (active) list


def test_bulk_archive_skips_classes_not_owned(client, token_factory):
    teacher = token_factory("teacher")
    other_teacher = token_factory("teacher", user_id=TEACHER_B)
    mine = make_classroom(client, teacher, name="Mine")
    theirs = make_classroom(client, other_teacher, name="Theirs")

    res = client.post(
        "/api/lms/classrooms/bulk-archive",
        json={"classroomIds": [mine["id"], theirs["id"]]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["archived"] == [mine["id"]]
    assert body["skipped"] == [theirs["id"]]


def test_bulk_archive_by_term(client, token_factory):
    teacher = token_factory("teacher")
    term = client.post(
        "/api/lms/terms",
        json={"name": "2025-26", "startDate": "2025-06-01T00:00:00Z", "endDate": "2026-04-30T00:00:00Z"},
        cookies=cookie(teacher),
    ).json()
    in_term = make_classroom(client, teacher, name="In term", termId=term["id"])
    out_of_term = make_classroom(client, teacher, name="Out of term")

    res = client.post(
        "/api/lms/classrooms/bulk-archive",
        json={"termId": term["id"]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    assert res.json()["archived"] == [in_term["id"]]

    listed_ids = {c["id"] for c in client.get("/api/lms/classrooms", cookies=cookie(teacher)).json()["classrooms"]}
    assert out_of_term["id"] in listed_ids
    assert in_term["id"] not in listed_ids


def test_get_student_classes_scoped_to_teachers_own_classes(client, token_factory):
    teacher = token_factory("teacher")
    other_teacher = token_factory("teacher", user_id=TEACHER_B)
    student = token_factory("student")

    mine = make_classroom(client, teacher, name="Mine")
    theirs = make_classroom(client, other_teacher, name="Theirs")
    for classroom in (mine, theirs):
        res = client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(student),
        )
        assert res.status_code == 200, res.text

    res = client.get(f"/api/lms/students/{STUDENT_A}", cookies=cookie(teacher))
    assert res.status_code == 200, res.text
    body = res.json()
    assert [c["classroomId"] for c in body["classrooms"]] == [mine["id"]]


def test_get_student_classes_for_a_student_the_teacher_never_taught_is_empty(client, token_factory):
    teacher = token_factory("teacher")
    res = client.get(f"/api/lms/students/{STUDENT_B}", cookies=cookie(teacher))
    assert res.status_code == 200, res.text
    assert res.json()["classrooms"] == []


def test_bulk_roster_add_and_remove(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"add": [{"studentId": STUDENT_A, "studentName": "Arjun"}, {"studentId": STUDENT_B, "studentName": "Bala"}]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["added"]) == {STUDENT_A, STUDENT_B}
    assert body["addSkipped"] == []

    roster = client.get(f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)).json()
    assert {s["studentId"] for s in roster["students"]} == {STUDENT_A, STUDENT_B}

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"remove": [STUDENT_A]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    assert res.json()["removed"] == [STUDENT_A]

    roster = client.get(f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)).json()
    assert {s["studentId"] for s in roster["students"]} == {STUDENT_B}


def test_bulk_roster_add_skips_duplicates_without_failing_the_batch(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"add": [{"studentId": STUDENT_A}]},
        cookies=cookie(teacher),
    )
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"add": [{"studentId": STUDENT_A}, {"studentId": STUDENT_B}]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["added"] == [STUDENT_B]
    assert body["addSkipped"] == [STUDENT_A]


def test_bulk_roster_remove_requires_owner_not_co_teacher(client, token_factory, monkeypatch):
    import co_teachers

    teacher = token_factory("teacher")
    co_teacher = token_factory("teacher", user_id=TEACHER_B)
    classroom = make_classroom(client, teacher)

    def _stub_lookup(settings, email, school_id):
        return {"userId": TEACHER_B, "name": "Co Teacher", "role": "teacher", "schoolId": school_id}

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup)
    add_co = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "co@example.com"},
        cookies=cookie(teacher),
    )
    assert add_co.status_code == 201, add_co.text

    client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"add": [{"studentId": STUDENT_A}]},
        cookies=cookie(teacher),
    )

    # A co-teacher can add...
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"add": [{"studentId": STUDENT_B}]},
        cookies=cookie(co_teacher),
    )
    assert res.status_code == 200, res.text

    # ...but not remove, in the same batch shape as a solo remove.
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/bulk",
        json={"remove": [STUDENT_A]},
        cookies=cookie(co_teacher),
    )
    assert res.status_code == 403, res.text


def test_student_can_list_terms(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    client.post(
        "/api/lms/terms",
        json={"name": "2026-27", "startDate": "2026-06-01T00:00:00Z", "endDate": "2027-04-30T00:00:00Z"},
        cookies=cookie(teacher),
    )
    res = client.get("/api/lms/student/terms", cookies=cookie(student))
    assert res.status_code == 200, res.text
    assert len(res.json()["terms"]) == 1


def test_teacher_only_terms_route_still_rejects_students(client, token_factory):
    student = token_factory("student")
    res = client.get("/api/lms/terms", cookies=cookie(student))
    assert res.status_code == 403
