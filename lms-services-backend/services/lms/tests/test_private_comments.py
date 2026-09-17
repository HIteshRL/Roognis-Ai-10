from conftest import SCHOOL_B, STUDENT_A, STUDENT_B


def cookie(token):
    return {"jwt": token}


def setup_submission(client, teacher, student, **coursework_overrides):
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "maxPoints": 10, **coursework_overrides},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    submission = client.post(
        f"/api/lms/coursework/{coursework['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    ).json()
    return classroom, coursework, submission


def test_student_posts_private_comment_teacher_sees_it(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Can you clarify question 2?", "submissionId": submission["id"]},
        cookies=cookie(student),
    )
    assert res.status_code == 201, res.text
    comment = res.json()
    assert comment["visibility"] == "private"
    assert comment["submissionId"] == submission["id"]

    teacher_view = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"submissionId": submission["id"]},
        cookies=cookie(teacher),
    ).json()["comments"]
    assert [c["id"] for c in teacher_view] == [comment["id"]]


def test_teacher_posts_private_comment_student_sees_it(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "Nice work, but check your units.", "submissionId": submission["id"]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text

    student_view = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"submissionId": submission["id"]},
        cookies=cookie(student),
    ).json()["comments"]
    assert len(student_view) == 1

    notifs = client.get("/api/lms/notifications", cookies=cookie(student)).json()["notifications"]
    assert any(n["type"] == "private_comment" for n in notifs)


def test_another_student_cannot_view_or_post_private_comments(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student", user_id=STUDENT_A)
    student_b = token_factory("student", user_id=STUDENT_B)
    classroom, coursework, submission = setup_submission(client, teacher, student_a)
    client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student_b)
    )

    # B cannot post a private comment on A's submission.
    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "snooping", "submissionId": submission["id"]},
        cookies=cookie(student_b),
    )
    assert post.status_code == 403

    # A posts one; B cannot list it via submissionId.
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "question", "submissionId": submission["id"]},
        cookies=cookie(student_a),
    )
    listing = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"submissionId": submission["id"]},
        cookies=cookie(student_b),
    )
    assert listing.status_code == 403


def test_private_comment_never_leaks_into_general_coursework_thread(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)

    client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "private note", "submissionId": submission["id"]},
        cookies=cookie(teacher),
    )
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "public question", "courseworkId": coursework["id"]},
        cookies=cookie(student),
    )

    general = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"courseworkId": coursework["id"]},
        cookies=cookie(student),
    ).json()["comments"]
    assert [c["body"] for c in general] == ["public question"]

    unfiltered = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments", cookies=cookie(teacher)
    ).json()["comments"]
    assert all(c["visibility"] != "private" for c in unfiltered)


def test_reply_inherits_private_visibility_regardless_of_body(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)

    parent = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "please clarify", "submissionId": submission["id"]},
        cookies=cookie(student),
    ).json()

    # Teacher replies without repeating submissionId — the request even
    # falsely claims announcementId, which must be ignored for a reply.
    reply = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "sure, see part b", "parentId": parent["id"], "announcementId": "not-a-real-id"},
        cookies=cookie(teacher),
    )
    assert reply.status_code == 201, reply.text
    assert reply.json()["visibility"] == "private"
    assert reply.json()["submissionId"] == submission["id"]

    replies = client.get(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        params={"submissionId": submission["id"], "parentId": parent["id"]},
        cookies=cookie(student),
    ).json()["comments"]
    assert len(replies) == 1


def test_submission_comment_cannot_also_target_announcement(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)
    announcement = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "hi"},
        cookies=cookie(teacher),
    ).json()

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "x", "submissionId": submission["id"], "announcementId": announcement["id"]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_cross_school_submission_is_404(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom, coursework, submission = setup_submission(client, teacher, student)
    other_school_teacher = token_factory("teacher", school_id=SCHOOL_B)
    other_classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(other_school_teacher)
    ).json()

    res = client.post(
        f"/api/lms/classrooms/{other_classroom['id']}/comments",
        json={"body": "x", "submissionId": submission["id"]},
        cookies=cookie(other_school_teacher),
    )
    assert res.status_code == 404


def test_reacting_to_a_private_comment_is_gated_the_same_way(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student", user_id=STUDENT_A)
    student_b = token_factory("student", user_id=STUDENT_B)
    classroom, coursework, submission = setup_submission(client, teacher, student_a)
    client.post(
        "/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student_b)
    )
    comment = client.post(
        f"/api/lms/classrooms/{classroom['id']}/comments",
        json={"body": "note", "submissionId": submission["id"]},
        cookies=cookie(teacher),
    ).json()

    forbidden = client.post(
        f"/api/lms/comments/{comment['id']}/reactions", json={"emoji": "👍"}, cookies=cookie(student_b)
    )
    assert forbidden.status_code == 403

    allowed = client.post(
        f"/api/lms/comments/{comment['id']}/reactions", json={"emoji": "👍"}, cookies=cookie(student_a)
    )
    assert allowed.status_code == 200
