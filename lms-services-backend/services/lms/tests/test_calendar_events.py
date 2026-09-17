from conftest import SCHOOL_B, STUDENT_A


def cookie(token):
    return {"jwt": token}


def make_class_with_student(client, teacher, student):
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    client.post("/api/lms/enrollments/join", json={"joinCode": classroom["joinCode"]}, cookies=cookie(student))
    return classroom


def test_teacher_creates_event_student_can_list_it(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Midterm exam", "startsAt": "2026-09-15T09:00:00Z", "endsAt": "2026-09-15T10:30:00Z"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text
    event = res.json()
    assert event["title"] == "Midterm exam"

    listing = client.get(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events", cookies=cookie(student)
    ).json()["events"]
    assert [e["id"] for e in listing] == [event["id"]]


def test_student_cannot_create_event(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Sneaky event", "startsAt": "2026-09-15T09:00:00Z"},
        cookies=cookie(student),
    )
    assert res.status_code == 403


def test_ends_before_starts_is_rejected(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()

    res = client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Bad event", "startsAt": "2026-09-15T09:00:00Z", "endsAt": "2026-09-15T08:00:00Z"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 422


def test_update_and_delete_event(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    event = client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Field trip", "startsAt": "2026-09-20T09:00:00Z"},
        cookies=cookie(teacher),
    ).json()

    updated = client.patch(
        f"/api/lms/calendar-events/{event['id']}", json={"title": "Field trip (rescheduled)"}, cookies=cookie(teacher)
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["title"] == "Field trip (rescheduled)"

    deleted = client.delete(f"/api/lms/calendar-events/{event['id']}", cookies=cookie(teacher))
    assert deleted.status_code == 200
    listing = client.get(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events", cookies=cookie(teacher)
    ).json()["events"]
    assert listing == []


def test_cross_school_event_is_404(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "X", "subject": "Y"}, cookies=cookie(teacher)
    ).json()
    event = client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Exam", "startsAt": "2026-09-15T09:00:00Z"},
        cookies=cookie(teacher),
    ).json()

    intruder = token_factory("teacher", school_id=SCHOOL_B)
    res = client.patch(f"/api/lms/calendar-events/{event['id']}", json={"title": "Hijacked"}, cookies=cookie(intruder))
    assert res.status_code == 404


def test_event_appears_on_aggregate_calendar_alongside_coursework(client, token_factory):
    teacher, student = token_factory("teacher"), token_factory("student")
    classroom = make_class_with_student(client, teacher, student)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "dueAt": "2026-09-15T23:59:00Z"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{coursework['id']}/publish", cookies=cookie(teacher))
    client.post(
        f"/api/lms/classrooms/{classroom['id']}/calendar-events",
        json={"title": "Midterm exam", "startsAt": "2026-09-15T09:00:00Z"},
        cookies=cookie(teacher),
    )

    calendar = client.get(
        "/api/lms/calendar",
        params={"start": "2026-09-01T00:00:00Z", "end": "2026-09-30T00:00:00Z"},
        cookies=cookie(student),
    ).json()
    day = next(d for d in calendar["days"] if d["date"] == "2026-09-15")
    kinds = sorted(e["kind"] for e in day["events"])
    assert kinds == ["coursework", "event"]
