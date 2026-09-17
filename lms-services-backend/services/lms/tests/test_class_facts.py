"""Sprint 3, T4.2: GET /api/lms/classrooms/{id}/class-facts — the batched
server-side snapshot that lets web/'s `loadClassSnapshot` collapse its 1+N
fan-out into one request. Verifies the response matches what the
individual roster/coursework/gradebook/submissions endpoints already
return, since `buildClassFacts` on the frontend is untouched and depends
on exactly that shape.
"""
from conftest import STUDENT_A


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def test_class_facts_matches_the_individual_endpoints(client, token_factory):
    teacher = token_factory("teacher")
    student = token_factory("student")
    classroom = make_classroom(client, teacher)
    client.post(
        "/api/lms/enrollments/join",
        json={"joinCode": classroom["joinCode"]},
        cookies=cookie(student),
    )
    created = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{created['id']}/publish", cookies=cookie(teacher))
    submit = client.post(
        f"/api/lms/coursework/{created['id']}/submit",
        json={"text": "done"},
        cookies=cookie(student),
    )
    assert submit.status_code == 201, submit.text

    facts = client.get(
        f"/api/lms/classrooms/{classroom['id']}/class-facts", cookies=cookie(teacher)
    )
    assert facts.status_code == 200, facts.text
    body = facts.json()

    roster = client.get(
        f"/api/lms/classrooms/{classroom['id']}/students", cookies=cookie(teacher)
    ).json()["students"]
    assert body["students"] == roster

    coursework_list = client.get(
        f"/api/lms/classrooms/{classroom['id']}/coursework", cookies=cookie(teacher)
    ).json()["coursework"]
    assert body["coursework"] == coursework_list

    gradebook = client.get(
        f"/api/lms/classrooms/{classroom['id']}/gradebook", cookies=cookie(teacher)
    ).json()
    assert body["gradebook"] == gradebook

    assert body["detailedCourseworkIds"] == [created["id"]]
    submissions = body["submissionsByCoursework"][created["id"]]
    assert len(submissions) == 1
    assert submissions[0]["studentId"] == STUDENT_A

    assert body["classroom"]["id"] == classroom["id"]


def test_class_facts_window_respects_recent_limit(client, token_factory):
    """Only PUBLISHED, gradeable coursework enters the submission window —
    a draft or a `material` item must not cost a query nobody needs."""
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)

    published = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Published HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{published['id']}/publish", cookies=cookie(teacher))

    draft = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Draft HW", "type": "assignment", "maxPoints": 10},
        cookies=cookie(teacher),
    ).json()

    material = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Reading material", "type": "material"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{material['id']}/publish", cookies=cookie(teacher))

    facts = client.get(
        f"/api/lms/classrooms/{classroom['id']}/class-facts", cookies=cookie(teacher)
    ).json()
    assert facts["detailedCourseworkIds"] == [published["id"]]
    # All three still appear in the full coursework list — buildClassFacts
    # does its own published/gradeable filtering client-side.
    assert {c["id"] for c in facts["coursework"]} == {published["id"], draft["id"], material["id"]}


def test_class_facts_requires_teacher(client, token_factory):
    student = token_factory("student")
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    res = client.get(
        f"/api/lms/classrooms/{classroom['id']}/class-facts", cookies=cookie(student)
    )
    assert res.status_code == 403
