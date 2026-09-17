from datetime import datetime, timedelta, timezone

from conftest import STUDENT_A


def cookie(token):
    return {"jwt": token}


def setup_class_with_student(client, teacher, student):
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Class 8 Science", "subject": "Science"},
        cookies=cookie(teacher),
    ).json()
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    return classroom


def test_full_coursework_lifecycle(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)

    # Teacher creates a draft assignment.
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Photosynthesis worksheet", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    assert coursework["status"] == "draft"

    # Draft is invisible to students.
    student_view = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"]
    assert student_view == []

    # Publish → now visible.
    published = client.post(
        f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher)
    ).json()
    assert published["status"] == "published"
    assert published["publishedAt"]

    student_view = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"]
    assert len(student_view) == 1
    assert student_view[0]["mySubmission"] is None

    # Student submits.
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Plants convert light into energy."},
        cookies=cookie(student),
    )
    assert submission.status_code == 201, submission.text
    submission = submission.json()
    assert submission["status"] == "turned_in"
    assert submission["content"] == {"text": "Plants convert light into energy."}

    # Teacher sees one turned-in submission.
    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()
    assert submissions["stats"]["turnedIn"] == 1
    assert submissions["submissions"][0]["studentId"] == STUDENT_A
    assert submissions["submissions"][0]["studentName"] == "Test Student"

    # Teacher grades and returns.
    graded = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 9, "feedback": "Great work"},
        cookies=cookie(teacher),
    ).json()
    assert graded["grade"] == 9.0
    assert graded["status"] == "returned"

    # Student sees the grade on their submission list.
    my_subs = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()["submissions"]
    assert my_subs[0]["grade"] == 9.0
    assert my_subs[0]["feedback"] == "Great work"


def test_non_enrolled_student_cannot_submit(client, token_factory):
    teacher = token_factory("teacher")
    enrolled = token_factory("student")
    classroom = setup_class_with_student(client, teacher, enrolled)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "W", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    outsider = token_factory("student", user_id="99999999-9999-9999-9999-999999999999")
    res = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "hi"},
        cookies=cookie(outsider),
    )
    assert res.status_code == 403


def test_grade_cannot_exceed_max_points(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "W", "type": "assignment", "maxPoints": 5},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "answer"},
        cookies=cookie(student),
    ).json()

    res = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400
    # Sprint 1, T3.3: the message must name the offending submission, not
    # just the bound — this is what the bulk-grade acceptance test relies on.
    assert submission["id"] in res.json()["detail"]


def test_material_cannot_be_submitted(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    material = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Read this", "type": "material"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{material['id']}/publish", cookies=cookie(teacher))

    res = client.post(
        f"/api/lms/coursework/{material['id']}/submit",
        json={"text": "x"},
        cookies=cookie(student),
    )
    assert res.status_code == 400


def test_scheduled_coursework_publishes_lazily_and_notifies_once(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    scheduled_for = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz", "type": "assignment", "scheduledFor": scheduled_for},
        cookies=cookie(teacher),
    ).json()
    assert created["status"] == "scheduled"

    # Not visible before the scheduled read-time flip.
    first = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"]
    assert len(first) == 1
    assert first[0]["status"] == "published"
    assert first[0]["scheduledFor"] is None

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert notifs["unreadCount"] == 1
    assert notifs["notifications"][0]["type"] == "coursework_published"

    # A second read must not flip again or notify again.
    second = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"]
    assert second[0]["status"] == "published"
    after = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert after["unreadCount"] == 1


def test_save_draft_then_turn_in(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    saved = client.post(
        f"/api/lms/coursework/{coursework['id']}/save",
        json={"text": "Work in progress..."},
        cookies=cookie(student),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["status"] == "draft"

    # Reloading shows the saved draft text, and it doesn't count as turned in.
    reloaded = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"][0]
    assert reloaded["mySubmission"]["status"] == "draft"
    assert reloaded["mySubmission"]["content"] == {"text": "Work in progress..."}

    stats = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["stats"]
    assert stats["turnedIn"] == 0

    # Turning in moves the count.
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "Final answer."},
        cookies=cookie(student),
    )
    stats = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["stats"]
    assert stats["turnedIn"] == 1


def test_allow_resubmission_default_true_but_flag_blocks_when_false(client, token_factory):
    from database import SessionLocal
    from models import Coursework

    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "One-shot quiz", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    assert coursework["allowResubmission"] is True  # C1 default preserves pre-existing behavior
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "first try"},
        cookies=cookie(student),
    )
    resubmit = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "second try"},
        cookies=cookie(student),
    )
    assert resubmit.status_code == 201, resubmit.text  # default allows it

    # Flip it directly at the model level to test the gate itself in
    # isolation from the request models (see
    # test_allow_resubmission_settable_via_create_and_update below for the
    # API path, wired up in the Phase 4.4 refinement pass — previously no
    # request model accepted this field at all).
    db = SessionLocal()
    try:
        row = db.get(Coursework, coursework["id"])
        row.allow_resubmission = False
        db.commit()
    finally:
        db.close()

    blocked = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "third try"},
        cookies=cookie(student),
    )
    assert blocked.status_code == 409

    # A save (draft) → turn-in sequence is never gated by the flag, even
    # with allow_resubmission=False, since draft->turned_in isn't a
    # resubmission.
    coursework2 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Another", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework2['id']}/publish", cookies=cookie(teacher))
    db = SessionLocal()
    try:
        row = db.get(Coursework, coursework2["id"])
        row.allow_resubmission = False
        db.commit()
    finally:
        db.close()
    client.post(
        f"/api/lms/coursework/{coursework2['id']}/save",
        json={"text": "draft"},
        cookies=cookie(student),
    )
    turn_in = client.post(
        f"/api/lms/coursework/{coursework2['id']}/submit",
        json={"text": "final"},
        cookies=cookie(student),
    )
    assert turn_in.status_code == 201, turn_in.text


def test_allow_resubmission_settable_via_create_and_update(client, token_factory):
    """Phase 4.4b: the allow_resubmission column and its enforcement shipped
    in Sprint 1, but neither CreateCourseworkRequest nor
    UpdateCourseworkRequest accepted the field — frozen contract C1 was
    inert in production; every assignment permanently allowed resubmission
    regardless of a teacher's intent. Verifies both the create-time and
    update-time paths actually persist the value, and that omitting it
    (None) still falls back to the True default rather than the default
    becoming unreachable a different way."""
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)

    one_shot = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "One-shot", "type": "assignment", "allowResubmission": False},
        cookies=cookie(teacher),
    ).json()
    assert one_shot["allowResubmission"] is False

    default = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Default", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    assert default["allowResubmission"] is True

    flipped = client.patch(
        f"/api/lms/coursework/{default['id']}",
        json={"allowResubmission": False},
        cookies=cookie(teacher),
    )
    assert flipped.status_code == 200, flipped.text
    assert flipped.json()["allowResubmission"] is False

    # The gate created at request time actually takes effect, end to end.
    client.post(f"/api/lms/coursework/{one_shot['id']}/publish", cookies=cookie(teacher))
    client.post(
        f"/api/lms/coursework/{one_shot['id']}/submit", json={"text": "first"}, cookies=cookie(student)
    )
    blocked = client.post(
        f"/api/lms/coursework/{one_shot['id']}/submit", json={"text": "second"}, cookies=cookie(student)
    )
    assert blocked.status_code == 409


def test_allow_resubmission_false_blocks_save_draft_bypass(client, token_factory):
    """Save-as-draft on an already-turned-in submission must be gated by
    `allow_resubmission` the same as a direct resubmit — otherwise a student
    could flip status back to `draft` via /save (no allow_resubmission
    check) and then /submit again, since a `draft` row no longer trips
    submit_coursework's `status == turned_in` guard."""
    from database import SessionLocal
    from models import Coursework

    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "One-shot quiz", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    db = SessionLocal()
    try:
        row = db.get(Coursework, coursework["id"])
        row.allow_resubmission = False
        db.commit()
    finally:
        db.close()

    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "first try"},
        cookies=cookie(student),
    )
    save_attempt = client.post(
        f"/api/lms/coursework/{coursework['id']}/save",
        json={"text": "trying to revert to draft"},
        cookies=cookie(student),
    )
    assert save_attempt.status_code == 409, save_attempt.text

    # Confirm the bypass is actually closed: submission is still turned_in,
    # not draft, so a second submit is still blocked too.
    resubmit = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "second try"},
        cookies=cookie(student),
    )
    assert resubmit.status_code == 409, resubmit.text


def test_coursework_attachments_round_trip_as_list(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={
            "title": "Reading",
            "type": "material",
            "attachments": [{"type": "link", "url": "https://example.com/reading", "title": "Chapter 3"}],
        },
        cookies=cookie(teacher),
    ).json()
    assert coursework["attachments"] == [
        {"type": "link", "url": "https://example.com/reading", "title": "Chapter 3"}
    ]
    assert coursework["rubricCriteria"] is None

    fetched = client.get(f"/api/lms/coursework/{coursework['id']}", cookies=cookie(teacher)).json()
    assert fetched["attachments"] == coursework["attachments"]


def test_grade_withheld_until_returned(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "answer"},
        cookies=cookie(student),
    ).json()

    # Teacher grades but withholds — status stays turned_in, not returned.
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 9, "feedback": "Nice", "returnToStudent": False},
        cookies=cookie(teacher),
    )

    my_subs = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()["submissions"]
    assert my_subs[0]["status"] == "turned_in"
    assert my_subs[0]["grade"] is None
    assert my_subs[0]["feedback"] is None

    my_coursework = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()["coursework"][0]
    assert my_coursework["mySubmission"]["grade"] is None

    # Teacher's own view is unaffected — full payload always.
    teacher_view = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"][0]
    assert teacher_view["grade"] == 9.0
    assert teacher_view["feedback"] == "Nice"

    # Now actually return it — visible to the student.
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 9, "feedback": "Nice", "returnToStudent": True},
        cookies=cookie(teacher),
    )
    my_subs = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()["submissions"]
    assert my_subs[0]["status"] == "returned"
    assert my_subs[0]["grade"] == 9.0


def test_submission_denominator_reflects_roster(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Denominator Test", "subject": "Math"},
        cookies=cookie(teacher),
    ).json()
    students = [
        token_factory("student", user_id=f"a0000000-0000-0000-0000-00000000000{i}")
        for i in range(5)
    ]
    for s in students:
        client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(s),
        )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Homework", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    # Only 2 of 5 turn in.
    for s in students[:2]:
        client.post(
            f"/api/lms/coursework/{coursework['id']}/submit",
            json={"text": "done"},
            cookies=cookie(s),
        )

    stats = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["stats"]
    assert stats == {
        "assignedCount": 5,
        "turnedIn": 2,
        "graded": 0,
        "gradedNotReturned": 0,
        "missing": 3,
    }

    # Grade+return one of the two turned-in — it moves from turnedIn to
    # graded, but a returned submission was never "missing" either way.
    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"]
    client.post(
        f"/api/lms/submissions/{submissions[0]['id']}/grade",
        json={"grade": 8},
        cookies=cookie(teacher),
    )
    stats = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["stats"]
    assert stats == {
        "assignedCount": 5,
        "turnedIn": 1,
        "graded": 1,
        "gradedNotReturned": 0,
        "missing": 3,
    }


def test_bulk_grade_thirty_submissions_in_one_request(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Bulk Grade Test", "subject": "Science"},
        cookies=cookie(teacher),
    ).json()
    students = [
        token_factory("student", user_id=f"b0000000-0000-0000-0000-{i:012d}")
        for i in range(30)
    ]
    for s in students:
        client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(s),
        )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Big Quiz", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    submission_ids = []
    for s in students:
        sub = client.post(
            f"/api/lms/coursework/{coursework['id']}/submit",
            json={"text": "done"},
            cookies=cookie(s),
        ).json()
        submission_ids.append(sub["id"])

    bulk = client.post(
        f"/api/lms/coursework/{coursework['id']}/grades",
        json={"grades": [{"submissionId": sid, "grade": 9} for sid in submission_ids]},
        cookies=cookie(teacher),
    )
    assert bulk.status_code == 200, bulk.text
    graded = bulk.json()["graded"]
    assert len(graded) == 30
    assert all(g["status"] == "returned" for g in graded)

    stats = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["stats"]
    assert stats == {
        "assignedCount": 30,
        "turnedIn": 0,
        "graded": 30,
        "gradedNotReturned": 0,
        "missing": 0,
    }


def test_bulk_grade_over_max_rejects_whole_batch(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id="c0000000-0000-0000-0000-000000000001")
    classroom = setup_class_with_student(client, teacher, student_a)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student_b),
    )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz", "type": "assignment", "maxPoints": 5},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    sub_a = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "a"}, cookies=cookie(student_a)
    ).json()
    sub_b = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "b"}, cookies=cookie(student_b)
    ).json()

    res = client.post(
        f"/api/lms/coursework/{coursework['id']}/grades",
        json={"grades": [
            {"submissionId": sub_a["id"], "grade": 4},
            {"submissionId": sub_b["id"], "grade": 8},  # over max_points=5
        ]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400
    assert sub_b["id"] in res.json()["detail"]

    # Whole batch rejected — sub_a must NOT have been graded either.
    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"]
    assert all(s["grade"] is None for s in submissions)


def test_return_all_only_flips_graded_submissions(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id="d0000000-0000-0000-0000-000000000001")
    classroom = setup_class_with_student(client, teacher, student_a)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student_b),
    )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    sub_a = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "a"}, cookies=cookie(student_a)
    ).json()
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "b"}, cookies=cookie(student_b)
    )
    # Grade only student A's, withheld.
    client.post(
        f"/api/lms/submissions/{sub_a['id']}/grade",
        json={"grade": 7, "returnToStudent": False},
        cookies=cookie(teacher),
    )

    res = client.post(f"/api/lms/coursework/{coursework['id']}/return-all", cookies=cookie(teacher))
    assert res.status_code == 200, res.text
    assert res.json()["returnedCount"] == 1
    assert res.json()["submissionIds"] == [sub_a["id"]]

    submissions = client.get(
        f"/api/lms/coursework/{coursework['id']}/submissions", cookies=cookie(teacher)
    ).json()["submissions"]
    by_id = {s["id"]: s for s in submissions}
    assert by_id[sub_a["id"]]["status"] == "returned"
    ungraded = [s for s in submissions if s["id"] != sub_a["id"]][0]
    assert ungraded["status"] == "turned_in"


def test_return_all_writes_grade_history_visible_to_the_student(client, token_factory):
    """Sprint 4, P3 (frozen contract C13 / Trap C): before this fix,
    `return_all_graded` flipped `status` with no `GradeHistory` row, so
    `list_grade_history`'s `returned_only` filter — applied whenever the
    *student* reads their own history — hid the very event that revealed
    the grade. A student whose grade came back via this button saw an
    empty history. Test as the student: the teacher's own view (unfiltered)
    would have passed even with the bug."""
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "essay"}, cookies=cookie(student)
    ).json()
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8, "returnToStudent": False},
        cookies=cookie(teacher),
    )

    res = client.post(f"/api/lms/coursework/{coursework['id']}/return-all", cookies=cookie(teacher))
    assert res.status_code == 200, res.text
    assert res.json()["returnedCount"] == 1

    rows = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(student)
    ).json()["history"]
    assert len(rows) == 1, "return-all must write a GradeHistory row, not just flip status"
    assert rows[0]["grade"] == 8
    assert rows[0]["returned"] is True
    assert rows[0]["isBackfilled"] is False


def test_rubric_scores_compute_grade_and_still_bounded_by_max_points(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    rubric = client.post(
        f"/api/lms/classrooms/{classroom['id']}/rubrics",
        json={"title": "Essay rubric", "criteria": [
            {"criterion": "Clarity", "maxPoints": 5},
            {"criterion": "Grammar", "maxPoints": 5},
        ]},
        cookies=cookie(teacher),
    ).json()
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/rubrics/{rubric['id']}/attach",
        json={"courseworkId": coursework["id"]},
        cookies=cookie(teacher),
    )
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "My essay."},
        cookies=cookie(student),
    ).json()

    graded = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"rubricScores": [
            {"criterion": "Clarity", "points": 5},
            {"criterion": "Grammar", "points": 5},
        ]},
        cookies=cookie(teacher),
    )
    assert graded.status_code == 200, graded.text
    assert graded.json()["grade"] == 10.0
    assert graded.json()["rubricScores"] == [
        {"criterion": "Clarity", "points": 5.0},
        {"criterion": "Grammar", "points": 5.0},
    ]

    # A criterion score exceeding its own maxPoints is rejected.
    over_criterion = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"rubricScores": [{"criterion": "Clarity", "points": 6}, {"criterion": "Grammar", "points": 5}]},
        cookies=cookie(teacher),
    )
    assert over_criterion.status_code == 400

    # An unknown criterion is rejected, naming it.
    unknown = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"rubricScores": [{"criterion": "Neatness", "points": 1}]},
        cookies=cookie(teacher),
    )
    assert unknown.status_code == 400
    assert "Neatness" in unknown.json()["detail"]

    # A rubric total exceeding the coursework's own max_points is rejected,
    # naming the submission (same message convention as T3.3).
    coursework2 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay 2", "type": "assignment", "maxPoints": 8},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/rubrics/{rubric['id']}/attach",
        json={"courseworkId": coursework2["id"]},
        cookies=cookie(teacher),
    )
    client.post(f"/api/lms/coursework/{coursework2['id']}/publish", cookies=cookie(teacher))
    submission2 = client.post(
        f"/api/lms/coursework/{coursework2['id']}/submit",
        json={"text": "Another essay."},
        cookies=cookie(student),
    ).json()
    over_total = client.post(
        f"/api/lms/submissions/{submission2['id']}/grade",
        json={"rubricScores": [
            {"criterion": "Clarity", "points": 5},
            {"criterion": "Grammar", "points": 5},
        ]},
        cookies=cookie(teacher),
    )
    assert over_total.status_code == 400
    assert submission2["id"] in over_total.json()["detail"]


def test_teacher_cannot_grade_across_schools(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = setup_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "W", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "answer"},
        cookies=cookie(student),
    ).json()

    intruder = token_factory("teacher", user_id="88888888-8888-8888-8888-888888888888", school_id="44444444-4444-4444-4444-444444444444")
    res = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 1},
        cookies=cookie(intruder),
    )
    assert res.status_code == 404
