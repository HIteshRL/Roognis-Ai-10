from conftest import SCHOOL_B, STUDENT_A, STUDENT_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def _stub_lookup(user_id, name="Invited Student", role="student"):
    def _lookup(settings, email, school_id):
        return {"userId": user_id, "name": name, "role": role, "schoolId": school_id}

    return _lookup


def test_invite_student_by_email_enrolls_immediately(client, token_factory, monkeypatch):
    import student_invitations

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)

    monkeypatch.setattr(student_invitations.clients, "lookup_student_by_email", _stub_lookup(STUDENT_A))

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "student@example.com"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text
    assert res.json()["studentId"] == STUDENT_A
    assert res.json()["status"] == "active"

    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    assert [s["studentId"] for s in roster] == [STUDENT_A]


def test_invite_unknown_email_tells_teacher_to_use_join_code(client, token_factory, monkeypatch):
    import student_invitations

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)

    monkeypatch.setattr(
        student_invitations.clients, "lookup_student_by_email", lambda settings, email, school_id: None
    )

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "nobody@example.com"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400
    assert "join code" in res.json()["detail"]


def test_invite_already_enrolled_student_is_409(client, token_factory, monkeypatch):
    import student_invitations

    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    monkeypatch.setattr(student_invitations.clients, "lookup_student_by_email", _stub_lookup(STUDENT_A))
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "student@example.com"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 409


def test_invite_a_co_teacher_email_is_409(client, token_factory, monkeypatch):
    import co_teachers
    import student_invitations

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B, role="teacher"))
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(teacher),
    )

    monkeypatch.setattr(student_invitations.clients, "lookup_student_by_email", _stub_lookup(TEACHER_B))
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "coteacher@example.com"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 409


def test_non_owner_teacher_cannot_invite(client, token_factory, monkeypatch):
    import student_invitations

    owner = token_factory("teacher")
    intruder = token_factory("teacher", user_id=TEACHER_B, school_id=SCHOOL_B)
    classroom = make_classroom(client, owner)

    monkeypatch.setattr(student_invitations.clients, "lookup_student_by_email", _stub_lookup(STUDENT_B))
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "student@example.com"},
        cookies=cookie(intruder),
    )
    assert res.status_code == 404


def test_student_cannot_invite(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/students/invite",
        json={"email": "x@example.com"},
        cookies=cookie(student),
    )
    assert res.status_code == 403
