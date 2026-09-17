"""Regression tests for the Sprint 1 + Sprint 2 refinement pass.

Each test here pins a defect that the shipped code had and that the existing
112-test suite did not catch. Several of the gaps sat *between* two passing
tests — e.g. test_grade_history covered "withheld grade, read by the teacher"
and "returned grade, read by the student" but never "withheld grade, read by
the student", which was the one combination that leaked.
"""
from conftest import SCHOOL_B, STUDENT_A, STUDENT_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def open_stream_classroom(client, teacher, name="Open Stream"):
    """A classroom students may post to. `streamPermission` lives under
    `settings` and is set by PATCH, not on create."""
    classroom = client.post(
        "/api/lms/classrooms", json={"name": name, "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    updated = client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "post_and_comment"}},
        cookies=cookie(teacher),
    )
    assert updated.status_code == 200, updated.text
    return classroom


def setup_submission(client, teacher, student, *, max_points=10):
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
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "maxPoints": max_points},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    ).json()
    return classroom, coursework, submission


# ── 1.1 Grade history must honour the withholding contract ───────────────────

def test_student_cannot_read_a_withheld_grade_through_grade_history(client, token_factory):
    """The gap between test_grade_history's two existing tests: one grades with
    returnToStudent=False but reads as the teacher, the other reads as the
    student but grades with the default True."""
    teacher, student = token_factory("teacher"), token_factory("student")
    _classroom, _coursework, submission = setup_submission(client, teacher, student)

    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 9, "feedback": "Not ready to hand back", "returnToStudent": False},
        cookies=cookie(teacher),
    )

    # The student's own submission read already withheld it correctly...
    mine = client.get("/api/lms/student/submissions", cookies=cookie(student)).json()
    assert all(s["grade"] is None for s in mine["submissions"])

    # ...and the audit trail must agree rather than route around it.
    history = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(student)
    )
    assert history.status_code == 200, history.text
    assert history.json()["history"] == []

    # The teacher still sees the full trail.
    teacher_view = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]
    assert [e["grade"] for e in teacher_view] == [9]


def test_student_sees_returned_entries_but_not_withheld_ones(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    _classroom, _coursework, submission = setup_submission(client, teacher, student)

    for grade, returned in ((4, False), (6, True), (8, False)):
        client.post(
            f"/api/lms/submissions/{submission['id']}/grade",
            json={"grade": grade, "returnToStudent": returned},
            cookies=cookie(teacher),
        )

    student_view = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(student)
    ).json()["history"]
    teacher_view = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]

    assert [e["grade"] for e in student_view] == [6]
    assert [e["grade"] for e in teacher_view] == [4, 6, 8]


# ── 1.2 Re-grading must not silently wipe rubric scores or feedback ──────────

def test_regrade_without_feedback_preserves_the_existing_feedback(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    _classroom, _coursework, submission = setup_submission(client, teacher, student)

    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 6, "feedback": "Check your working"},
        cookies=cookie(teacher),
    )
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8},
        cookies=cookie(teacher),
    )

    rows = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]
    assert rows[-1]["grade"] == 8
    assert rows[-1]["feedback"] == "Check your working"


def test_bulk_grade_rejects_rubric_graded_coursework(client, token_factory):
    """Sprint 4, P3: superseded the earlier "preserve rubric scores" fix
    below. That fix stopped bulk grading from wiping `rubricScores` to
    None, but didn't notice the deeper problem it left standing: a bulk
    grade still replaced the flat `grade` while `rubric_scores` kept its
    *previous* value — a submission bulk-graded to 9 with a rubric
    breakdown still summing to 7. `grade_submission`'s own `None`-means-
    "leave it alone" convention preserved the stale breakdown instead of
    clearing it, so "preserved" was itself the bug, just a quieter one.
    Bulk grading a rubric-graded item is rejected outright now — the bulk
    lane's semantics ("same value, many students") were never meaningful
    for a per-criterion breakdown in the first place."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Rubric Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    # A rubric is its own resource, created then attached — not inlined on
    # coursework create.
    rubric = client.post(
        f"/api/lms/classrooms/{classroom['id']}/rubrics",
        json={
            "title": "Essay rubric",
            "criteria": [
                {"criterion": "Structure", "maxPoints": 5},
                {"criterion": "Evidence", "maxPoints": 5},
            ],
        },
        cookies=cookie(teacher),
    ).json()
    attached = client.post(
        f"/api/lms/rubrics/{rubric['id']}/attach",
        json={"courseworkId": coursework["id"]},
        cookies=cookie(teacher),
    )
    assert attached.status_code == 200, attached.text
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "essay"}, cookies=cookie(student)
    ).json()

    graded = client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={
            "rubricScores": [
                {"criterion": "Structure", "points": 4},
                {"criterion": "Evidence", "points": 3},
            ]
        },
        cookies=cookie(teacher),
    )
    assert graded.status_code == 200, graded.text
    assert graded.json()["grade"] == 7

    bulk = client.post(
        f"/api/lms/coursework/{coursework['id']}/grades",
        json={"grades": [{"submissionId": submission["id"], "grade": 9}], "returnToStudent": True},
        cookies=cookie(teacher),
    )
    assert bulk.status_code == 400, bulk.text
    assert "rubric" in bulk.json()["detail"].lower()

    # The rejected bulk attempt must not have touched the rubric-graded row.
    rows = client.get(
        f"/api/lms/submissions/{submission['id']}/grade-history", cookies=cookie(teacher)
    ).json()["history"]
    assert len(rows) == 1
    assert rows[-1]["grade"] == 7
    assert rows[-1]["rubricScores"] is not None
    assert {r["criterion"] for r in rows[-1]["rubricScores"]} == {"Structure", "Evidence"}


# ── 1.3 Join codes are school-scoped ─────────────────────────────────────────

def test_join_code_from_another_school_is_rejected(client, token_factory):
    teacher_a = token_factory("teacher")
    student_b = token_factory("student", user_id=STUDENT_B, school_id=SCHOOL_B)

    classroom = client.post(
        "/api/lms/classrooms", json={"name": "School A Maths", "subject": "Maths"}, cookies=cookie(teacher_a)
    ).json()

    joined = client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student_b),
    )
    # 404, not 403 — never confirm the class exists in another school.
    assert joined.status_code == 404, joined.text

    # And no roster pollution: the class still reports zero students.
    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher_a)
    ).json()
    assert roster["students"] == []

    listed = client.get("/api/lms/student/classrooms", cookies=cookie(student_b)).json()
    assert listed["classrooms"] == []


def test_join_code_within_the_same_school_still_works(client, token_factory):
    """Guards against the school check being written too tightly."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Same School", "subject": "Maths"}, cookies=cookie(teacher)
    ).json()

    joined = client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    assert joined.status_code == 200, joined.text


# ── 1.4 @mentions are restricted to classroom members ────────────────────────

def test_mentioning_a_non_member_sends_them_nothing(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    outsider_id = STUDENT_B
    outsider = token_factory("student", user_id=outsider_id)

    classroom = open_stream_classroom(client, teacher, "Private Class")
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    posted = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Read this now", "mentions": [outsider_id]},
        cookies=cookie(student),
    )
    assert posted.status_code in (200, 201), posted.text

    # The outsider is in the same school but not this class — they must not be
    # reachable through another user's comment box.
    inbox = client.get("/api/lms/notifications", cookies=cookie(outsider)).json()
    assert inbox["notifications"] == []


def test_mentioning_a_real_classmate_still_notifies_them(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classmate_id = STUDENT_B
    classmate = token_factory("student", user_id=classmate_id)

    classroom = open_stream_classroom(client, teacher, "Open Class")
    for who in (student, classmate):
        client.post(
            "/api/lms/enrollments/join",
            json={"joinCode": classroom["joinCode"]},
            cookies=cookie(who),
        )

    client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Question for you", "mentions": [classmate_id]},
        cookies=cookie(student),
    )

    inbox = client.get("/api/lms/notifications", cookies=cookie(classmate)).json()
    assert any(n["type"] == "mention" for n in inbox["notifications"])


def test_mentions_are_bounded(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = open_stream_classroom(client, teacher, "Bounded")
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    flood = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "spam", "mentions": [f"user-{n}" for n in range(500)]},
        cookies=cookie(student),
    )
    assert flood.status_code == 422, flood.text


# ── 1.5 Pinning is teacher-only on every path ────────────────────────────────

def test_student_author_cannot_pin_their_own_post_via_patch(client, token_factory):
    """The create path and the dedicated /pin endpoint both guarded this; PATCH
    did not, and _get_editable admits the author."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = open_stream_classroom(client, teacher, "Open Stream")
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )

    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Look at me"},
        cookies=cookie(student),
    ).json()
    assert post["isPinned"] is False

    pinned = client.patch(
        f"/api/lms/announcements/{post['id']}", json={"isPinned": True}, cookies=cookie(student)
    )
    assert pinned.status_code == 403, pinned.text


def test_student_author_can_still_edit_their_own_post(client, token_factory):
    """The pin guard must not turn into a blanket edit block for authors."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = open_stream_classroom(client, teacher, "Open Stream")
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Typo here"},
        cookies=cookie(student),
    ).json()

    edited = client.patch(
        f"/api/lms/announcements/{post['id']}", json={"body": "Fixed"}, cookies=cookie(student)
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["body"] == "Fixed"


def test_teacher_can_pin_via_patch(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Teacher Stream", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Important"},
        cookies=cookie(teacher),
    ).json()

    pinned = client.patch(
        f"/api/lms/announcements/{post['id']}", json={"isPinned": True}, cookies=cookie(teacher)
    )
    assert pinned.status_code == 200, pinned.text
    assert pinned.json()["isPinned"] is True
