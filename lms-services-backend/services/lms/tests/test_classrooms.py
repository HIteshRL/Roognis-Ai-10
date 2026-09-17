from conftest import SCHOOL_B, STUDENT_A, STUDENT_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "service": "lms"}


def test_requires_auth(client):
    assert client.get("/api/lms/classrooms").status_code == 401


def test_student_cannot_create_classroom(client, token_factory):
    res = client.post(
        "/api/lms/classrooms",
        json={"name": "X", "subject": "Y"},
        cookies=cookie(token_factory("student")),
    )
    assert res.status_code == 403


def test_create_and_list_classroom(client, token_factory):
    teacher = token_factory("teacher")
    created = make_classroom(client, teacher)
    assert created["joinCode"]
    assert created["studentCount"] == 0
    assert created["color"].startswith("#")

    listed = client.get("/api/lms/classrooms", cookies=cookie(teacher)).json()["classrooms"]
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]


def test_join_by_code_and_roster(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)

    join = client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    assert join.status_code == 200, join.text
    assert join.json()["status"] == "active"

    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    assert [s["studentId"] for s in roster] == [STUDENT_A]
    # Name captured from the student's JWT at join time (name-based identity).
    assert roster[0]["studentName"] == "Test Student"

    mine = client.get("/api/lms/student/classrooms", cookies=cookie(student)).json()["classrooms"]
    assert mine[0]["id"] == classroom["id"]


def test_join_requires_approval_flow(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher, requireApproval=True)

    join = client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    assert join.json()["status"] == "pending"

    # Not yet active → not on the active roster.
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    assert roster == []

    pending = client.get(
        f"/api/lms/classrooms/{classroom['id']}/enrollments/pending", cookies=cookie(teacher)
    ).json()["pending"]
    assert [p["studentId"] for p in pending] == [STUDENT_A]

    approve = client.post(
        f"/api/lms/classrooms/{classroom['id']}/enrollments/{STUDENT_A}/approve",
        cookies=cookie(teacher),
    )
    assert approve.status_code == 200
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    assert [s["studentId"] for s in roster] == [STUDENT_A]


def test_stream_permission_settable_and_enforced(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    # Default permission (comment_only) blocks student posting — currently
    # impossible for any class in the system, per the Sprint 1 acceptance test.
    denied = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Hi"},
        cookies=cookie(student),
    )
    assert denied.status_code == 403

    update = client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "post_and_comment"}},
        cookies=cookie(teacher),
    )
    assert update.status_code == 200, update.text
    assert update.json()["settings"]["stream_permission"] == "post_and_comment"

    allowed = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Hi"},
        cookies=cookie(student),
    )
    assert allowed.status_code == 201, allowed.text


def test_classroom_settings_merge_not_replace(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher, requireApproval=True)

    client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "teachers_only"}},
        cookies=cookie(teacher),
    )
    updated = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(teacher)).json()
    assert updated["settings"]["require_approval"] is True
    assert updated["settings"]["stream_permission"] == "teachers_only"


def test_invalid_stream_permission_rejected(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    res = client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "nonsense"}},
        cookies=cookie(teacher),
    )
    assert res.status_code == 422


def test_bad_join_code(client, token_factory):
    res = client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": "NOPE123"},
        cookies=cookie(token_factory("student")),
    )
    assert res.status_code == 404


def test_teacher_cannot_touch_other_schools_classroom(client, token_factory):
    owner = token_factory("teacher")
    classroom = make_classroom(client, owner)

    # Same role, different school + user → must not see or own it.
    intruder = token_factory("teacher", user_id=TEACHER_B, school_id="44444444-4444-4444-4444-444444444444")
    res = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(intruder))
    assert res.status_code == 404


def _stub_lookup(user_id, name="Co Teacher", role="teacher"):
    def _lookup(settings, email, school_id):
        return {"userId": user_id, "name": name, "role": role, "schoolId": school_id}

    return _lookup


def test_owner_adds_co_teacher_who_can_grade_and_post_but_not_delete(client, token_factory, monkeypatch):
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)  # same school as owner
    student = token_factory("student")
    classroom = make_classroom(client, owner)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "post_and_comment"}},
        cookies=cookie(owner),
    )

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))

    add = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )
    assert add.status_code == 201, add.text
    assert add.json()["userId"] == TEACHER_B

    # A non-owner teacher (even the co-teacher themself) cannot add another one.
    forbidden = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "x@example.com"},
        cookies=cookie(co_teacher_user),
    )
    assert forbidden.status_code == 403

    # Co-teacher can post to the stream.
    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Homework due Friday"},
        cookies=cookie(co_teacher_user),
    )
    assert post.status_code == 201, post.text

    # Co-teacher can grade a submission.
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "maxPoints": 10},
        cookies=cookie(owner),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(owner))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    ).json()
    grade = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8},
        cookies=cookie(co_teacher_user),
    )
    assert grade.status_code == 200, grade.text

    # Co-teacher cannot delete the classroom.
    delete = client.delete(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(co_teacher_user))
    assert delete.status_code == 403

    # Cross-school access still 404s — the widened helper didn't break this.
    cross_school_intruder = token_factory("teacher", user_id=TEACHER_B, school_id=SCHOOL_B)
    cross = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(cross_school_intruder))
    assert cross.status_code == 404

    # Owner removes the co-teacher; they lose access again.
    remove = client.delete(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers/{TEACHER_B}", cookies=cookie(owner)
    )
    assert remove.status_code == 200
    revoked = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(co_teacher_user))
    assert revoked.status_code == 403


def test_co_teacher_sees_their_class_in_the_classroom_list(client, token_factory, monkeypatch):
    """Phase 4.1: the prior test proves a co-teacher can grade/post/manage a
    class they already know the id of (get_owned_classroom admits them). This
    proves the separate bug: list_teacher_classrooms — the query behind
    GET /api/lms/classrooms — only ever matched Classroom.teacher_id, so a
    co-teacher who navigated to /classes the normal way found nothing there
    at all, despite having full teaching access to it."""
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    owned_only = make_classroom(client, owner, name="Owner's other class")
    shared = make_classroom(client, owner, name="Shared class")

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    added = client.post(
        f"/api/lms/classrooms/{shared['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )
    assert added.status_code == 201, added.text

    listed = client.get("/api/lms/classrooms", cookies=cookie(co_teacher_user)).json()
    listed_ids = {c["id"] for c in listed["classrooms"]}
    assert shared["id"] in listed_ids
    assert owned_only["id"] not in listed_ids, "a co-teacher must not see classes they aren't added to"

    # And the owner's own listing is unaffected — still sees both.
    owner_listed = client.get("/api/lms/classrooms", cookies=cookie(owner)).json()
    owner_ids = {c["id"] for c in owner_listed["classrooms"]}
    assert {owned_only["id"], shared["id"]} <= owner_ids


def test_co_teacher_sees_their_class_on_the_calendar(client, token_factory, monkeypatch):
    """calendar_view.py's _accessible_classroom_ids calls the same
    list_teacher_classrooms — so the co-teacher's calendar was empty for the
    identical reason as the classroom list, and the same fix covers both."""
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    classroom = make_classroom(client, owner)

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )

    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Due soon", "dueAt": "2026-12-01T00:00:00Z"},
        cookies=cookie(owner),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(owner))

    calendar = client.get(
        "/api/lms/calendar?start=2026-11-01T00:00:00Z&end=2026-12-31T00:00:00Z",
        cookies=cookie(co_teacher_user),
    ).json()
    course_ids = {
        entry.get("courseworkId")
        for day in calendar["days"]
        for entry in day["events"]
    }
    assert coursework["id"] in course_ids


def test_co_teacher_cannot_remove_a_student_but_can_approve_and_invite(client, token_factory, monkeypatch):
    """Pins the Phase 4.2 boundary decision, so a later session doesn't
    'fix' remove_student into matching invite/approve by mistake. Unlike
    guardians.py's _teacher_teaches_student (a real oversight — no
    co-teacher check at all, no stated reason), remove_student's owner-only
    restriction is a deliberate, commented design choice in main.py: kicking
    a student out is higher-impact than an onboarding-gate decision
    (invite/approve/reject), so it stays owner-only while those stay
    co-teacher-allowed. Co-teacher management itself (add/remove a
    co-teacher) is separately owner-only for a different, also-deliberate
    reason — self-referential control over who else teaches the class."""
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    student = token_factory("student")
    classroom = make_classroom(client, owner)
    client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student)
    )

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    added = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )
    assert added.status_code == 201, added.text

    # Co-teacher CAN approve a pending enrollment (onboarding-gate decision).
    client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"requireApproval": True}},
        cookies=cookie(owner),
    )
    pending_student = token_factory("student", user_id="88888888-8888-8888-8888-888888888888")
    client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(pending_student)
    )
    approve = client.post(
        f"/api/lms/classrooms/{classroom['id']}/enrollments/88888888-8888-8888-8888-888888888888/approve",
        cookies=cookie(co_teacher_user),
    )
    assert approve.status_code == 200, approve.text

    # Co-teacher CANNOT remove an already-active student — stays owner-only.
    # `student` was created via token_factory("student") with no explicit
    # user_id, which defaults to STUDENT_A (see conftest.py).
    remove = client.delete(
        f"/api/lms/classrooms/{classroom['id']}/students/{STUDENT_A}",
        cookies=cookie(co_teacher_user),
    )
    assert remove.status_code == 403

    # Co-teacher CANNOT add another co-teacher — stays owner-only.
    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup("99999999-9999-9999-9999-999999999999"))
    add_co_teacher_attempt = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "another@example.com"},
        cookies=cookie(co_teacher_user),
    )
    assert add_co_teacher_attempt.status_code == 403


def test_co_teacher_does_not_pollute_student_roster_or_count(client, token_factory, monkeypatch):
    import co_teachers

    owner = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, owner)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )

    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(owner)
    ).json()["students"]
    assert [s["studentId"] for s in roster] == [STUDENT_A]

    refreshed = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(owner)).json()
    assert refreshed["studentCount"] == 1

    co_teachers_list = client.get(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers", cookies=cookie(owner)
    ).json()["coTeachers"]
    assert [c["userId"] for c in co_teachers_list] == [TEACHER_B]

    gradebook = client.get(
        f"/api/lms/classrooms/{classroom['id']}/gradebook", cookies=cookie(owner)
    ).json()
    assert [row["studentId"] for row in gradebook["rows"]] == [STUDENT_A]
    assert gradebook["studentCount"] == 1


def test_co_teacher_is_not_notified_like_a_student(client, token_factory, monkeypatch):
    import co_teachers

    owner = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, owner)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )

    client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Homework due Friday"},
        cookies=cookie(owner),
    )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "maxPoints": 10},
        cookies=cookie(owner),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(owner))

    student_notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert any(n["type"] == "new_announcement" for n in student_notifs["notifications"])
    assert any(n["type"] == "coursework_published" for n in student_notifs["notifications"])

    co_teacher_notifs = client.get("/api/lms/notifications", cookies=cookie(co_teacher_user)).json()
    assert co_teacher_notifs["notifications"] == []


def test_cannot_add_enrolled_student_as_co_teacher(client, token_factory, monkeypatch):
    import co_teachers

    owner = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, owner)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    monkeypatch.setattr(
        co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(STUDENT_A, name="Test Student")
    )
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "student@example.com"},
        cookies=cookie(owner),
    )
    assert res.status_code == 409


def test_chapters_publish_visibility(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    ch1 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/chapters",
        json={"title": "Chapter 1"},
        cookies=cookie(teacher),
    ).json()
    ch2 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/chapters",
        json={"title": "Chapter 2"},
        cookies=cookie(teacher),
    ).json()
    assert ch2["orderIndex"] == ch1["orderIndex"] + 1

    # Unpublish chapter 2 → student sees only chapter 1.
    client.patch(f"/api/lms/chapters/{ch2['id']}", json={"isPublished": False}, cookies=cookie(teacher))
    visible = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/chapters", cookies=cookie(student)
    ).json()["chapters"]
    assert [c["id"] for c in visible] == [ch1["id"]]


def test_internal_chapter_access(client, token_factory, internal_headers):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    chapter = client.post(
        f"/api/lms/classrooms/{classroom['id']}/chapters",
        json={"title": "Photosynthesis", "knowledgeBaseId": "kb-123"},
        cookies=cookie(teacher),
    ).json()

    # Not enrolled yet → not allowed.
    denied = client.get(
        "/api/lms/internal/chapter-access",
        params={"chapterId": chapter["id"], "studentId": STUDENT_A},
        headers=internal_headers,
    ).json()
    assert denied["allowed"] is False

    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    allowed = client.get(
        "/api/lms/internal/chapter-access",
        params={"chapterId": chapter["id"], "studentId": STUDENT_A},
        headers=internal_headers,
    ).json()
    assert allowed["allowed"] is True
    assert allowed["knowledgeBaseId"] == "kb-123"


def test_internal_requires_token(client, token_factory):
    res = client.get(
        "/api/lms/internal/enrollment",
        params={"classroomId": "x", "studentId": STUDENT_B},
    )
    assert res.status_code == 401
