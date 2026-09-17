"""Regression tests for the N+1 collapses in Phase 3.2.

The risk in a GROUP BY-based batch rewrite isn't "does it run" — the
existing suite already exercises each of these routes with a single item,
which a per-item-vs-batched bug can't tell apart from correct code. The risk
is a value landing on the *wrong* item: a swapped dict key, an id used as
its own default, or a subquery correlated to the wrong column. Every test
below therefore creates at least two items with deliberately different
counts and asserts each one gets its own value, not the other's.
"""
from datetime import datetime, timedelta, timezone

from conftest import STUDENT_B


def cookie(token):
    return {"jwt": token}


def test_coursework_list_submission_stats_are_not_swapped_between_items(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Two Item Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    # HW1: turned in. HW2: untouched (still "assigned").
    hw1 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "HW1"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{hw1['id']}/publish", cookies=cookie(teacher))
    client.post(f"/api/lms/coursework/{hw1['id']}/submit", json={"text": "done"}, cookies=cookie(student))

    hw2 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "HW2"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{hw2['id']}/publish", cookies=cookie(teacher))

    # HW3: graded but withheld (Sprint 4, P3 / frozen contract C2 amendment)
    # — `gradedNotReturned` must land on HW3 only, never on HW1 or HW2, the
    # same swap risk every other assertion in this file guards against.
    hw3 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "HW3"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{hw3['id']}/publish", cookies=cookie(teacher))
    sub3 = client.post(
        f"/api/lms/coursework/{hw3['id']}/submit", json={"text": "done"}, cookies=cookie(student)
    ).json()
    client.post(
        f"/api/lms/submissions/{sub3['id']}/grade",
        json={"grade": 8, "returnToStudent": False},
        cookies=cookie(teacher),
    )

    listed = client.get(f"/api/lms/classrooms/{classroom['id']}/coursework", cookies=cookie(teacher)).json()
    by_id = {c["id"]: c for c in listed["coursework"]}

    assert by_id[hw1["id"]]["submissionStats"]["turnedIn"] == 1
    assert by_id[hw1["id"]]["submissionStats"]["missing"] == 0
    assert by_id[hw1["id"]]["submissionStats"]["gradedNotReturned"] == 0
    assert by_id[hw2["id"]]["submissionStats"]["turnedIn"] == 0
    assert by_id[hw2["id"]]["submissionStats"]["missing"] == 1
    assert by_id[hw2["id"]]["submissionStats"]["gradedNotReturned"] == 0
    assert by_id[hw3["id"]]["submissionStats"]["gradedNotReturned"] == 1
    assert by_id[hw3["id"]]["submissionStats"]["graded"] == 0


def test_student_coursework_my_submission_is_not_swapped_between_items(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Two Item Class B", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))

    hw1 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "Submitted"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{hw1['id']}/publish", cookies=cookie(teacher))
    client.post(f"/api/lms/coursework/{hw1['id']}/submit", json={"text": "answer"}, cookies=cookie(student))

    hw2 = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "Untouched"}, cookies=cookie(teacher)
    ).json()
    client.post(f"/api/lms/coursework/{hw2['id']}/publish", cookies=cookie(teacher))

    listed = client.get(
        f"/api/lms/student/classrooms/{classroom['id']}/coursework", cookies=cookie(student)
    ).json()
    by_id = {c["id"]: c for c in listed["coursework"]}

    assert by_id[hw1["id"]]["mySubmission"] is not None
    assert by_id[hw1["id"]]["mySubmission"]["status"] == "turned_in"
    assert by_id[hw2["id"]]["mySubmission"] is None


def test_classroom_list_counts_are_not_swapped_between_classrooms(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id=STUDENT_B)

    big = client.post(
        "/api/lms/classrooms", json={"name": "Big Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    small = client.post(
        "/api/lms/classrooms", json={"name": "Small Class", "subject": "Maths"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": big["joinCode"]}, cookies=cookie(student_a))
    client.post("/api/lms/enrollments/join", json={"joinCode": big["joinCode"]}, cookies=cookie(student_b))
    client.post("/api/lms/enrollments/join", json={"joinCode": small["joinCode"]}, cookies=cookie(student_a))

    listed = client.get("/api/lms/classrooms", cookies=cookie(teacher)).json()
    by_id = {c["id"]: c for c in listed["classrooms"]}

    assert by_id[big["id"]]["studentCount"] == 2
    assert by_id[small["id"]]["studentCount"] == 1


def test_comment_list_reactions_and_reply_counts_are_not_swapped(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Discussion Class", "subject": "Science"},
        cookies=cookie(teacher),
    ).json()
    updated = client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"settings": {"streamPermission": "post_and_comment"}},
        cookies=cookie(teacher),
    )
    assert updated.status_code == 200
    joined = client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student)
    )
    assert joined.status_code == 200

    liked = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Popular comment"},
        cookies=cookie(teacher),
    ).json()
    quiet = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Quiet comment"},
        cookies=cookie(teacher),
    ).json()

    # Two reactions and one reply on `liked`; nothing on `quiet`.
    react_a = client.post(
        f"/api/lms/comments/{liked['id']}/reactions", json={"emoji": "👍"}, cookies=cookie(teacher)
    )
    react_b = client.post(
        f"/api/lms/comments/{liked['id']}/reactions", json={"emoji": "👍"}, cookies=cookie(student)
    )
    assert react_a.status_code == 200, react_a.text
    assert react_b.status_code == 200, react_b.text
    reply = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "A reply", "parentId": liked["id"]},
        cookies=cookie(student),
    )
    assert reply.status_code in (200, 201), reply.text

    listed = client.get(f"/api/lms/classrooms/{classroom['id']}/comments", cookies=cookie(teacher)).json()
    by_id = {c["id"]: c for c in listed["comments"]}

    assert by_id[liked["id"]]["reactions"] == {"👍": 2}
    assert by_id[liked["id"]]["replyCount"] == 1
    assert by_id[quiet["id"]]["reactions"] == {}
    assert by_id[quiet["id"]]["replyCount"] == 0


def test_announcement_list_comment_counts_are_not_swapped(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Stream Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()

    discussed = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Talk about this"},
        cookies=cookie(teacher),
    ).json()
    silent = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "No replies here"},
        cookies=cookie(teacher),
    ).json()

    for _ in range(3):
        client.post(
            f"/api/lms/classrooms/{classroom['id']}/comments",
            json={"body": "reply", "announcementId": discussed["id"]},
            cookies=cookie(teacher),
        )

    listed = client.get(f"/api/lms/classrooms/{classroom['id']}/announcements", cookies=cookie(teacher)).json()
    by_id = {a["id"]: a for a in listed["announcements"]}

    assert by_id[discussed["id"]]["commentCount"] == 3
    assert by_id[silent["id"]]["commentCount"] == 0
