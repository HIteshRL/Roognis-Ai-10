"""Sprint 3, T2.1-T2.4 / frozen contracts C8, C9: differentiated
assignments. Covers the demo-script acceptance criteria from
docs/SPRINT3_PLAN.md: a targeted item is visible only to its targets, the
denominator matches the target count (not the whole roster), an untargeted
student's gradebook cell is distinct from "missing", missing-work only
nudges targeted students, and groups resolve to a fixed set of targets at
publish time.
"""
import notification_types as ntype


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


def make_students(token_factory, n, prefix="s"):
    return [
        (i, token_factory("student", user_id=f"{prefix}-{i:02d}-{'a' * (24 - len(prefix))}"))
        for i in range(n)
    ]


def test_targeted_assignment_visible_only_to_targets(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 5)
    join_students(client, classroom, [tok for _, tok in students])

    # Need each student's real user id to target them - read it back off
    # the roster rather than re-deriving the token factory's id scheme.
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    targeted_ids = [roster[0]["studentId"], roster[1]["studentId"]]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Targeted HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()

    publish = client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": targeted_ids},
        cookies=cookie(teacher),
    )
    assert publish.status_code == 200, publish.text
    assert publish.json()["submissionStats"]["assignedCount"] == 2

    student_ids_by_index = {roster[i]["studentId"]: tok for i, tok in students}

    for sid, tok in student_ids_by_index.items():
        classroom_view = client.get(
            f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(tok)
        ).json()
        titles = [c["title"] for c in classroom_view["coursework"]]
        if sid in targeted_ids:
            assert "Targeted HW" in titles, f"{sid} should see the targeted item"
        else:
            assert "Targeted HW" not in titles, f"{sid} should NOT see the targeted item"

    # A non-targeted student can't reach it directly either (404, not 403 -
    # cross-visibility never confirms existence, per C7's convention).
    non_targeted_token = next(
        tok for sid, tok in student_ids_by_index.items() if sid not in targeted_ids
    )
    direct = client.post(
        f"/api/lms/coursework/{created['id']}/submit",
        json={"text": "attempt"},
        cookies=cookie(non_targeted_token),
    )
    assert direct.status_code == 404, direct.text


def test_denominator_matches_targets_not_roster(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 5)
    join_students(client, classroom, [tok for _, tok in students])
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    targeted_ids = [roster[0]["studentId"], roster[1]["studentId"], roster[2]["studentId"]]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": targeted_ids},
        cookies=cookie(teacher),
    )

    targeted_token = next(tok for i, tok in students if roster[i]["studentId"] == targeted_ids[0])
    submit = client.post(
        f"/api/lms/coursework/{created['id']}/submit",
        json={"text": "done"},
        cookies=cookie(targeted_token),
    )
    assert submit.status_code == 201, submit.text

    detail = client.get(f"/api/lms/coursework/{created['id']}", cookies=cookie(teacher)).json()
    assert detail["submissionStats"]["assignedCount"] == 3
    assert detail["submissionStats"]["turnedIn"] == 1
    assert detail["submissionStats"]["missing"] == 2


def test_gradebook_marks_untargeted_cell_not_applicable(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 3)
    join_students(client, classroom, [tok for _, tok in students])
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    targeted_ids = [roster[0]["studentId"]]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": targeted_ids},
        cookies=cookie(teacher),
    )

    gradebook = client.get(
        f"/api/lms/classrooms/{classroom['id']}/gradebook", cookies=cookie(teacher)
    ).json()
    cells_by_student = {row["studentId"]: row["cells"][created["id"]] for row in gradebook["rows"]}
    assert cells_by_student[targeted_ids[0]]["status"] == "missing"
    for sid, cell in cells_by_student.items():
        if sid != targeted_ids[0]:
            assert cell["status"] == "not_applicable", (sid, cell)


def test_missing_work_only_nudges_targeted_students(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 3)
    join_students(client, classroom, [tok for _, tok in students])
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    targeted_ids = [roster[0]["studentId"], roster[1]["studentId"]]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={
            "title": "Overdue HW",
            "type": "assignment",
            "maxPoints": 10,
            "dueAt": "2020-01-01T00:00:00Z",
        },
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": targeted_ids},
        cookies=cookie(teacher),
    )

    missing = client.get(
        f"/api/lms/classrooms/{classroom['id']}/missing-work", cookies=cookie(teacher)
    ).json()
    assert missing["totalMissing"] == 2
    missing_ids = {m["studentId"] for m in missing["items"][0]["missingStudents"]}
    assert missing_ids == set(targeted_ids)


def test_group_targeting_resolves_members_at_publish_time(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 4)
    join_students(client, classroom, [tok for _, tok in students])
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    group_member_ids = [roster[0]["studentId"], roster[1]["studentId"]]

    group = client.post(
        f"/api/lms/classrooms/{classroom['id']}/groups",
        json={"name": "Reading circle", "studentIds": group_member_ids},
        cookies=cookie(teacher),
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Group HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    publish = client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "groupIds": [group_id]},
        cookies=cookie(teacher),
    )
    assert publish.status_code == 200, publish.text
    assert publish.json()["submissionStats"]["assignedCount"] == 2

    # Changing the group's membership after publish must not move the
    # already-published item's targets (decision D9).
    update = client.patch(
        f"/api/lms/groups/{group_id}",
        json={"studentIds": [roster[2]["studentId"]]},
        cookies=cookie(teacher),
    )
    assert update.status_code == 200, update.text

    detail = client.get(f"/api/lms/coursework/{created['id']}", cookies=cookie(teacher)).json()
    assert detail["submissionStats"]["assignedCount"] == 2


def test_untargeted_publish_notifies_only_targets(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 3)
    join_students(client, classroom, [tok for _, tok in students])
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    targeted_ids = [roster[0]["studentId"]]

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Targeted HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": targeted_ids},
        cookies=cookie(teacher),
    )

    id_to_token = {roster[i]["studentId"]: tok for i, tok in students}
    for sid, tok in id_to_token.items():
        notifications = client.get("/api/lms/notifications", cookies=cookie(tok)).json()
        types = [n["type"] for n in notifications["notifications"]]
        if sid in targeted_ids:
            assert ntype.COURSEWORK_PUBLISHED in types, sid
        else:
            assert ntype.COURSEWORK_PUBLISHED not in types, sid


def test_publish_with_no_body_stays_class_wide(client, token_factory):
    """The pre-Sprint-3 client contract: omitting targeting entirely keeps
    an assignment visible to everyone, unchanged."""
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    students = make_students(token_factory, 2)
    join_students(client, classroom, [tok for _, tok in students])

    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Class-wide HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    publish = client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))
    assert publish.status_code == 200, publish.text
    assert publish.json()["submissionStats"]["assignedCount"] == 2

    for _, tok in students:
        seen = client.get(
            f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(tok)
        ).json()
        assert "Class-wide HW" in [c["title"] for c in seen["coursework"]]


def test_publish_students_mode_with_no_resolvable_targets_is_rejected(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    res = client.post(
        f"/api/lms/coursework/{created['id']}/publish",
        json={"targetMode": "students", "studentIds": []},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400, res.text
