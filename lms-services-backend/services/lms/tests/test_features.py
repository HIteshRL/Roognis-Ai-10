"""Tests for the Google-Classroom parity feature routers ported from v2:
stream, discussions, rubrics, topics, gradebook, calendar, guardians,
notifications."""
from datetime import datetime, timedelta, timezone

from conftest import SCHOOL_A, SCHOOL_B, STUDENT_A, STUDENT_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def make_class(client, teacher, name="Class 8 Science", subject="Science"):
    return client.post(
        "/api/lms/classrooms",
        json={"name": name, "subject": subject},
        cookies=cookie(teacher),
    ).json()


def enroll(client, classroom, student):
    return client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )


def make_class_with_student(client, teacher, student):
    classroom = make_class(client, teacher)
    enroll(client, classroom, student)
    return classroom


# ── Stream ───────────────────────────────────────────────────────────────────

def test_teacher_posts_announcement_student_sees_it(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Welcome to class!", "title": "Hello"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "published"

    seen = client.get(
        f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(student)
    ).json()["announcements"]
    assert len(seen) == 1
    assert seen[0]["body"] == "Welcome to class!"


def test_student_cannot_post_to_stream_by_default(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "can I post?"},
        cookies=cookie(student),
    )
    assert res.status_code == 403


def test_teacher_draft_hidden_from_students(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "draft post", "status": "draft"},
        cookies=cookie(teacher),
    )
    student_view = client.get(
        f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(student)
    ).json()["announcements"]
    assert student_view == []
    teacher_view = client.get(
        f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(teacher)
    ).json()["announcements"]
    assert len(teacher_view) == 1


# ── Notifications ────────────────────────────────────────────────────────────

def test_published_announcement_notifies_students(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Quiz tomorrow"},
        cookies=cookie(teacher),
    )
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert notifs["unreadCount"] >= 1
    assert notifs["notifications"][0]["type"] == "new_announcement"

    nid = notifs["notifications"][0]["id"]
    client.post(f"/api/lms/notifications/{nid}/read", cookies=cookie(student))
    after = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert after["unreadCount"] == 0


def test_scheduled_announcement_publishes_lazily_and_notifies_once(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    scheduled_for = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Test tomorrow", "status": "scheduled", "scheduledFor": scheduled_for},
        cookies=cookie(teacher),
    ).json()
    assert created["status"] == "scheduled"

    # The due scheduled post flips to published on the student's first read.
    first = client.get(
        f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(student)
    ).json()["announcements"]
    assert len(first) == 1
    assert first[0]["status"] == "published"
    assert first[0]["scheduledFor"] is None

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert notifs["unreadCount"] == 1
    assert notifs["notifications"][0]["type"] == "new_announcement"

    # A second read must not flip (already published) or notify again.
    second = client.get(
        f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(student)
    ).json()["announcements"]
    assert second[0]["status"] == "published"
    after = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert after["unreadCount"] == 1


def test_publish_coursework_notifies_students(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Photosynthesis worksheet", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()

    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert any(n["type"] == "coursework_published" for n in notifs["notifications"])


def test_grade_submission_notifies_only_when_returned(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Worksheet", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "answer"},
        cookies=cookie(student),
    ).json()

    # Graded but held back — no notification yet.
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8, "returnToStudent": False},
        cookies=cookie(teacher),
    )
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert not any(n["type"] == "coursework_returned" for n in notifs["notifications"])

    # Returned — now notified.
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8, "returnToStudent": True},
        cookies=cookie(teacher),
    )
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert any(n["type"] == "coursework_returned" for n in notifs["notifications"])
    returned_count = sum(1 for n in notifs["notifications"] if n["type"] == "coursework_returned")

    # Editing an already-returned submission (e.g. fixing a typo in feedback)
    # must not fire a second "grade returned" notification.
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8, "feedback": "Great work (typo fixed)", "returnToStudent": True},
        cookies=cookie(teacher),
    )
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert sum(1 for n in notifs["notifications"] if n["type"] == "coursework_returned") == returned_count


def test_notifications_are_scoped_to_school(client, token_factory):
    teacher = token_factory("teacher", school_id=SCHOOL_A)
    student_in_a = token_factory("student", user_id=STUDENT_A, school_id=SCHOOL_A)
    classroom = make_class_with_student(client, teacher, student_in_a)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Quiz tomorrow"},
        cookies=cookie(teacher),
    )

    same_user_other_school = token_factory("student", user_id=STUDENT_A, school_id=SCHOOL_B)
    cross_school = client.get("/api/lms/notifications", cookies=cookie(same_user_other_school)).json()
    assert cross_school["notifications"] == []
    assert cross_school["unreadCount"] == 0
    assert client.get(
        "/api/lms/notifications/unread-count", cookies=cookie(same_user_other_school)
    ).json()["unreadCount"] == 0

    home_school = client.get("/api/lms/notifications", cookies=cookie(student_in_a)).json()
    assert home_school["unreadCount"] >= 1


# ── Discussions ──────────────────────────────────────────────────────────────

def test_comment_thread_and_reactions(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    announcement = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Discuss chapter 3"},
        cookies=cookie(teacher),
    ).json()

    # Student comments on the announcement.
    comment = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Great chapter!", "announcementId": announcement["id"]},
        cookies=cookie(student),
    )
    assert comment.status_code == 201, comment.text
    comment = comment.json()

    # Teacher replies.
    reply = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Glad you liked it", "announcementId": announcement["id"], "parentId": comment["id"]},
        cookies=cookie(teacher),
    ).json()

    roots = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"announcementId": announcement["id"]},
        cookies=cookie(student),
    ).json()["comments"]
    assert len(roots) == 1
    assert roots[0]["replyCount"] == 1

    replies = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"parentId": comment["id"]},
        cookies=cookie(student),
    ).json()["comments"]
    assert replies[0]["id"] == reply["id"]

    # Reaction summary.
    reacted = client.post(
        f"/api/lms/comments/{comment['id']}/reactions",
        json={"emoji": "👍"},
        cookies=cookie(teacher),
    ).json()
    assert reacted["reactions"]["👍"] == 1


def test_mention_notifies_target(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": f"hey @{STUDENT_A}", "mentions": [STUDENT_A]},
        cookies=cookie(teacher),
    )
    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()
    assert any(n["type"] == "mention" for n in notifs["notifications"])


# ── Rubrics ──────────────────────────────────────────────────────────────────

def test_rubric_create_and_attach(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_class(client, teacher)
    rubric = client.post(
        f"/api/lms/classrooms/{classroom['id']}/rubrics",
        json={"title": "Essay rubric", "criteria": [
            {"criterion": "Clarity", "maxPoints": 5},
            {"criterion": "Grammar", "maxPoints": 5},
        ]},
        cookies=cookie(teacher),
    )
    assert rubric.status_code == 201, rubric.text
    rubric = rubric.json()
    assert rubric["maxPoints"] == 10

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
    fetched = client.get(f"/api/lms/coursework/{coursework['id']}", cookies=cookie(teacher)).json()
    assert len(fetched["rubricCriteria"]) == 2


# ── Topics ───────────────────────────────────────────────────────────────────

def test_topic_grouping(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_class(client, teacher)
    topic = client.post(
        f"/api/lms/classrooms/{classroom['id']}/topics",
        json={"name": "Unit 1: Cells"},
        cookies=cookie(teacher),
    )
    assert topic.status_code == 201, topic.text
    topic = topic.json()
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Cell diagram", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(
        f"/api/lms/coursework/{coursework['id']}/topic",
        json={"topicId": topic["id"]},
        cookies=cookie(teacher),
    )
    fetched = client.get(f"/api/lms/coursework/{coursework['id']}", cookies=cookie(teacher)).json()
    assert fetched["topicId"] == topic["id"]


# ── Gradebook ────────────────────────────────────────────────────────────────

def test_gradebook_matrix(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Test 1", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "answer"},
        cookies=cookie(student),
    ).json()
    client.post(
        f"/api/lms/submissions/{submission['id']}/grade",
        json={"grade": 8},
        cookies=cookie(teacher),
    )

    book = client.get(f"/api/lms/classrooms/{classroom['id']}/gradebook", cookies=cookie(teacher)).json()
    assert len(book["columns"]) == 1
    assert len(book["rows"]) == 1
    row = book["rows"][0]
    assert row["studentId"] == STUDENT_A
    assert row["cells"][coursework["id"]]["score"] == 8.0
    assert row["averagePercent"] == 80.0
    assert book["classAveragePercent"] == 80.0

    csv_res = client.get(f"/api/lms/classrooms/{classroom['id']}/gradebook.csv", cookies=cookie(teacher))
    assert csv_res.status_code == 200
    assert "Average %" in csv_res.text


def test_submission_stats_do_not_contradict_after_a_student_is_removed(client, token_factory):
    """Phase 4.4a. submission_stats counted every Submission row for the
    coursework, while assignedCount (count_students) reflects only the
    *current* roster — remove a student after they've turned something in
    and turnedIn kept counting their row while assignedCount dropped,
    so turnedIn could exceed assignedCount on screen (e.g. assignedCount: 0,
    turnedIn: 1). Both numbers must now describe the same population."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    client.post(
        f"/api/lms/coursework/{coursework['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    )

    removed = client.delete(f"/api/lms/classrooms/{classroom['id']}/students/{STUDENT_A}", cookies=cookie(teacher))
    assert removed.status_code == 200, removed.text

    listed = client.get(f"/api/lms/classrooms/{classroom['id']}/coursework", cookies=cookie(teacher)).json()
    stats = listed["coursework"][0]["submissionStats"]
    assert stats["assignedCount"] == 0
    assert stats["turnedIn"] == 0, "a removed student's submission must not still count as turned in"
    assert stats["turnedIn"] + stats["graded"] <= stats["assignedCount"]


def test_gradebook_average_excludes_null_max_points_items(client, token_factory):
    """Phase 4.3. grade_submission's own bound check is skipped for a
    null-maxPoints item (nothing to bound the grade against), so before the
    fix an 8-point grade on such an item added 8 to the numerator and 0 to
    the denominator — an 8/10 item plus one null-maxPoints 8 produced
    averagePercent: 130.0. The null-maxPoints item's own score must still
    show in its cell; it just can't be averaged as if it had a scale."""
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    scaled = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Scaled", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{scaled['id']}/publish", cookies=cookie(teacher))
    sub_scaled = client.post(
        f"/api/lms/coursework/{scaled['id']}/submit", json={"text": "a"}, cookies=cookie(student)
    ).json()
    client.post(
        f"/api/lms/submissions/{sub_scaled['id']}/grade", json={"grade": 5}, cookies=cookie(teacher)
    )

    unscaled = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Unscaled", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    assert unscaled["maxPoints"] is None
    client.post(f"/api/lms/coursework/{unscaled['id']}/publish", cookies=cookie(teacher))
    sub_unscaled = client.post(
        f"/api/lms/coursework/{unscaled['id']}/submit", json={"text": "b"}, cookies=cookie(student)
    ).json()
    client.post(
        f"/api/lms/submissions/{sub_unscaled['id']}/grade", json={"grade": 8}, cookies=cookie(teacher)
    )

    book = client.get(f"/api/lms/classrooms/{classroom['id']}/gradebook", cookies=cookie(teacher)).json()
    row = book["rows"][0]

    # The null-maxPoints cell still shows the raw score...
    assert row["cells"][unscaled["id"]]["score"] == 8.0
    # ...but the average is computed only from the scaled item: 5/10 = 50%,
    # never 130%.
    assert row["averagePercent"] == 50.0
    assert book["classAveragePercent"] == 50.0


# ── Calendar ─────────────────────────────────────────────────────────────────

def test_calendar_aggregates_due_dates(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Homework", "type": "assignment", "dueAt": "2030-01-15T10:00:00Z"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))

    cal = client.get(
        "/api/lms/calendar",
        params={"start": "2030-01-01T00:00:00Z", "end": "2030-02-01T00:00:00Z"},
        cookies=cookie(student),
    ).json()
    assert cal["total"] == 1
    assert cal["days"][0]["events"][0]["title"] == "Homework"


# Phase 4.4c: calendar_view.py's `start`/`end` naive/aware mixing fix has no
# SQLite-observable effect — verified by direct inspection (not a test):
# SQLAlchemy's SQLite DateTime(timezone=True) type strips tzinfo
# symmetrically from both stored values and bound query parameters before
# comparing, so a naive and an aware bound already coincide on this engine
# regardless of the fix. The real risk is Postgres-specific (psycopg
# interprets a naive datetime bound to a `timestamptz` column using the
# session's timezone, not UTC), and cannot be reproduced against the
# in-memory SQLite engine this suite runs on. No test added for this one —
# recording that gap here rather than keeping a test that would pass
# identically with or without the fix.


# ── Guardians ────────────────────────────────────────────────────────────────

def test_guardian_invite_and_summary(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    # Teacher invites a guardian for their enrolled student.
    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent@example.com"},
        cookies=cookie(teacher),
    )
    assert invited.status_code == 201, invited.text
    assert invited.json()["status"] == "pending"

    # A parent linked to STUDENT_A (via JWT studentIds) reads their students + summary.
    parent = token_factory("parent", user_id="77777777-7777-7777-7777-777777777777", studentIds=[STUDENT_A])
    students = client.get("/api/lms/guardian/students", cookies=cookie(parent)).json()["students"]
    assert students[0]["studentId"] == STUDENT_A

    summary = client.get(f"/api/lms/guardian/students/{STUDENT_A}/summary", cookies=cookie(parent))
    assert summary.status_code == 200
    assert "upcoming" in summary.json()


def test_teacher_cannot_invite_guardian_for_unrelated_student(client, token_factory):
    teacher = token_factory("teacher")
    make_class(client, teacher)  # teacher owns a class but STUDENT_B is not enrolled
    res = client.post(
        f"/api/lms/students/{STUDENT_B}/guardians",
        json={"guardianEmail": "x@example.com"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 403


def test_co_teacher_can_invite_a_guardian_for_a_student_in_their_class(client, token_factory, monkeypatch):
    """Phase 4.2: _teacher_teaches_student matched Classroom.teacher_id only,
    with no co-teacher check at all — unlike remove_student's owner-only
    carve-out (main.py), which states a reason (blast radius of kicking a
    student out), this one had none. A co-teacher can already grade this
    same student's work and see them on the roster; there's no narrower
    boundary to draw here than the one every other teaching action uses."""
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    student = token_factory("student")
    classroom = make_class_with_student(client, owner, student)

    def _stub_lookup(settings, email, school_id):
        return {"userId": TEACHER_B, "name": "Co Teacher", "role": "teacher", "schoolId": school_id}

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup)
    added = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )
    assert added.status_code == 201, added.text

    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent2@example.com"},
        cookies=cookie(co_teacher_user),
    )
    assert invited.status_code == 201, invited.text


def test_parent_cannot_view_unlinked_student(client, token_factory):
    parent = token_factory("parent", user_id="77777777-7777-7777-7777-777777777777", studentIds=[STUDENT_A])
    res = client.get(f"/api/lms/guardian/students/{STUDENT_B}/summary", cookies=cookie(parent))
    assert res.status_code == 403


# ── Guardian redeemable codes: generate → redeem → real cross-service link ──
#
# These characterize the gap the audit flagged: `invite_guardian` used to
# write a `Guardian` row that nothing ever consumed, and nothing ever called
# the Auth Service to establish the link that actually gates a parent's
# reads. `clients.link_parent_student` is stubbed here the same way
# `co_teachers.clients.lookup_teacher_by_email` is stubbed above — it is a
# real outbound HTTP call in production, unreachable from this unit suite —
# but the stub still lets us assert *that* it was called, and with what.

def test_guardian_generate_redeem_links_parent(client, token_factory, monkeypatch):
    import guardians

    calls = []
    monkeypatch.setattr(
        guardians.clients,
        "link_parent_student",
        lambda settings, parent_id, student_id, school_id: calls.append((parent_id, student_id, school_id)),
    )

    teacher, student = token_factory("teacher"), token_factory("student")
    make_class_with_student(client, teacher, student)

    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent3@example.com"},
        cookies=cookie(teacher),
    )
    assert invited.status_code == 201, invited.text
    code = invited.json()["code"]
    assert code and len(code) >= 4
    assert invited.json()["codeExpired"] is False

    parent_id = "88888888-8888-8888-8888-888888888888"
    parent = token_factory("parent", user_id=parent_id)
    redeemed = client.post("/api/lms/guardian/redeem", json={"code": code}, cookies=cookie(parent))
    assert redeemed.status_code == 200, redeemed.text
    body = redeemed.json()
    assert body["status"] == "active"
    assert body["guardianUserId"] == parent_id
    # Spent — a redeemed guardian's old code is no longer surfaced.
    assert "code" not in body

    # The point of this whole flow: the Auth Service call actually happened,
    # with the redeeming parent's own id, not just an LMS-local status flip.
    assert calls == [(parent_id, STUDENT_A, SCHOOL_A)]

    # One-time-use: the same code cannot be redeemed twice.
    again = client.post("/api/lms/guardian/redeem", json={"code": code}, cookies=cookie(parent))
    assert again.status_code == 409


def test_guardian_redeem_does_not_flip_status_if_auth_link_fails(client, token_factory, monkeypatch):
    """No half-linked state: if the Auth Service call fails, the LMS-local
    row must stay `pending` so a retry (or a fresh code) starts clean."""
    import guardians

    def _boom(settings, parent_id, student_id, school_id):
        raise guardians.clients.AuthServiceUnavailable("simulated outage")

    monkeypatch.setattr(guardians.clients, "link_parent_student", _boom)

    teacher, student = token_factory("teacher"), token_factory("student")
    make_class_with_student(client, teacher, student)
    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent5@example.com"},
        cookies=cookie(teacher),
    )
    code = invited.json()["code"]

    parent = token_factory("parent", user_id="99999999-9999-9999-9999-999999999999")
    res = client.post("/api/lms/guardian/redeem", json={"code": code}, cookies=cookie(parent))
    assert res.status_code == 503

    # Still pending, still the same code — nothing was half-committed.
    roster = client.get(f"/api/lms/students/{STUDENT_A}/guardians", cookies=cookie(teacher)).json()["guardians"]
    matching = [g for g in roster if g["guardianEmail"] == "parent5@example.com"]
    assert matching[0]["status"] == "pending"
    assert matching[0]["code"] == code


def test_guardian_redeem_rejects_unknown_code(client, token_factory):
    parent = token_factory("parent", user_id="88888888-8888-8888-8888-888888888888")
    res = client.post("/api/lms/guardian/redeem", json={"code": "NOTREAL1"}, cookies=cookie(parent))
    assert res.status_code == 404


def test_guardian_redeem_rejects_expired_code_until_regenerated(client, token_factory, monkeypatch):
    import guardians

    monkeypatch.setattr(guardians, "GUARDIAN_CODE_TTL_DAYS", -1)  # already expired the moment it's created
    monkeypatch.setattr(
        guardians.clients, "link_parent_student", lambda settings, parent_id, student_id, school_id: None
    )

    teacher, student = token_factory("teacher"), token_factory("student")
    make_class_with_student(client, teacher, student)
    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent6@example.com"},
        cookies=cookie(teacher),
    )
    assert invited.json()["codeExpired"] is True
    guardian_id = invited.json()["id"]
    stale_code = invited.json()["code"]

    parent = token_factory("parent", user_id="10101010-1010-1010-1010-101010101010")
    expired = client.post("/api/lms/guardian/redeem", json={"code": stale_code}, cookies=cookie(parent))
    assert expired.status_code == 410

    # A teacher can mint a fresh, non-expired code for the same invite.
    monkeypatch.setattr(guardians, "GUARDIAN_CODE_TTL_DAYS", 14)
    regenerated = client.post(f"/api/lms/guardians/{guardian_id}/regenerate-code", cookies=cookie(teacher))
    assert regenerated.status_code == 200, regenerated.text
    fresh = regenerated.json()
    assert fresh["codeExpired"] is False
    assert fresh["code"] != stale_code

    redeemed = client.post("/api/lms/guardian/redeem", json={"code": fresh["code"]}, cookies=cookie(parent))
    assert redeemed.status_code == 200, redeemed.text
    assert redeemed.json()["status"] == "active"


def test_guardian_redeem_rejects_code_from_another_school(client, token_factory, monkeypatch):
    import guardians

    monkeypatch.setattr(
        guardians.clients, "link_parent_student", lambda settings, parent_id, student_id, school_id: None
    )

    teacher, student = token_factory("teacher"), token_factory("student")
    make_class_with_student(client, teacher, student)
    invited = client.post(
        f"/api/lms/students/{STUDENT_A}/guardians",
        json={"guardianEmail": "parent7@example.com"},
        cookies=cookie(teacher),
    )
    code = invited.json()["code"]

    other_school_parent = token_factory(
        "parent", user_id="11111111-2222-3333-4444-555555555555", school_id=SCHOOL_B
    )
    res = client.post("/api/lms/guardian/redeem", json={"code": code}, cookies=cookie(other_school_parent))
    # 404, not 403 — never confirm a code exists in another school.
    assert res.status_code == 404


# ── Student todo ─────────────────────────────────────────────────────────────

def test_student_todo_buckets_every_state(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    now = datetime.now(timezone.utc)

    def make_and_publish(title, due_at=None):
        body = {"title": title, "type": "assignment", "maxPoints": 10}
        if due_at is not None:
            body["dueAt"] = due_at.isoformat()
        cw = client.post(
            f"/api/lms/classrooms/{classroom['id']}/coursework", json=body, cookies=cookie(teacher)
        ).json()
        client.post(f"/api/lms/coursework/{cw['id']}/publish", cookies=cookie(teacher))
        return cw

    due_today = make_and_publish("Due today", now + timedelta(hours=2))
    due_soon = make_and_publish("Due in 3 days", now + timedelta(days=3))
    overdue = make_and_publish("Overdue", now - timedelta(days=2))
    to_submit = make_and_publish("Awaiting grading")
    to_grade = make_and_publish("Already graded")

    submitted = client.post(
        f"/api/lms/coursework/{to_submit['id']}/submit", json={"text": "in progress"}, cookies=cookie(student)
    ).json()
    graded_submission = client.post(
        f"/api/lms/coursework/{to_grade['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    ).json()
    client.post(
        f"/api/lms/submissions/{graded_submission['id']}/grade",
        json={"grade": 9, "feedback": "Nice"},
        cookies=cookie(teacher),
    )

    todo = client.get("/api/lms/student/todo", cookies=cookie(student)).json()
    assert {i["courseworkId"] for i in todo["dueToday"]} == {due_today["id"]}
    assert {i["courseworkId"] for i in todo["upcoming"]} == {due_soon["id"]}
    assert {i["courseworkId"] for i in todo["overdue"]} == {overdue["id"]}
    assert {i["courseworkId"] for i in todo["missing"]} == {overdue["id"]}
    assert {i["courseworkId"] for i in todo["recentlySubmitted"]} == {to_submit["id"]}
    assert {i["courseworkId"] for i in todo["recentlyGraded"]} == {to_grade["id"]}
    assert todo["recentlyGraded"][0]["score"] == 9.0
    assert todo["generatedAt"]
