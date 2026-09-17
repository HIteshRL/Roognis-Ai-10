"""Sprint 4, P2 — repetitive-authoring reduction: duplicating a coursework
item (T2.1 / decision D17) and reusing a rubric across classrooms (T2.2).
The Quiz Service is stubbed via monkeypatch, matching test_quiz_link.py's
pattern — this suite runs against in-memory SQLite with no other services
reachable.
"""
from conftest import SCHOOL_B, TEACHER_B


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class 8 Science", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def _stub_quiz(quiz_id="quiz-1", school_id=None, status_="ready"):
    def _lookup(settings, quiz_id_arg):
        if quiz_id_arg != quiz_id:
            return None
        return {"id": quiz_id, "schoolId": school_id, "status": status_, "questionCount": 5, "title": "Quiz"}

    return _lookup


# ── T2.1 — duplicate a coursework item ───────────────────────────────────────

def test_duplicate_in_place_creates_a_draft_copy(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    source = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={
            "title": "Essay 1",
            "type": "assignment",
            "description": "Write about photosynthesis.",
            "topic": "Biology",
            "maxPoints": 10,
            "dueAt": "2026-10-01T00:00:00Z",
            "allowResubmission": False,
        },
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{source['id']}/publish", cookies=cookie(teacher))

    dup = client.post(f"/api/lms/coursework/{source['id']}/duplicate", cookies=cookie(teacher))
    assert dup.status_code == 201, dup.text
    body = dup.json()

    assert body["id"] != source["id"]
    assert body["title"] == "Essay 1 (copy)"
    assert body["classroomId"] == classroom["id"]
    assert body["description"] == "Write about photosynthesis."
    assert body["topic"] == "Biology"
    assert body["maxPoints"] == 10
    assert body["dueAt"] == source["dueAt"]
    assert body["allowResubmission"] is False
    # The run-specific state resets even though the source was published.
    assert body["status"] == "draft"
    assert body["publishedAt"] is None
    assert body["scheduledFor"] is None
    assert body["targetMode"] == "all"
    assert body["submissionStats"]["turnedIn"] == 0


def test_duplicate_accepts_a_custom_title(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    source = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Essay 1", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()

    dup = client.post(
        f"/api/lms/coursework/{source['id']}/duplicate",
        json={"title": "Essay 1 — Section B"},
        cookies=cookie(teacher),
    )
    assert dup.status_code == 201, dup.text
    assert dup.json()["title"] == "Essay 1 — Section B"


def test_duplicate_across_classrooms_drops_classroom_scoped_fields(client, token_factory):
    teacher = token_factory("teacher")
    classroom_a = make_classroom(client, teacher, name="Section A")
    classroom_b = make_classroom(client, teacher, name="Section B")
    chapter = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/chapters",
        json={"title": "Ch 1"},
        cookies=cookie(teacher),
    ).json()
    topic = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/topics",
        json={"name": "Unit 1"},
        cookies=cookie(teacher),
    ).json()
    source = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/coursework",
        json={"title": "Essay 1", "type": "assignment", "topic": "Biology", "chapterId": chapter["id"]},
        cookies=cookie(teacher),
    ).json()
    assign = client.post(
        f"/api/lms/coursework/{source['id']}/topic",
        json={"topicId": topic["id"]},
        cookies=cookie(teacher),
    )
    assert assign.status_code == 200, assign.text

    dup = client.post(
        f"/api/lms/coursework/{source['id']}/duplicate",
        json={"classroomId": classroom_b["id"]},
        cookies=cookie(teacher),
    )
    assert dup.status_code == 201, dup.text
    body = dup.json()
    assert body["classroomId"] == classroom_b["id"]
    # The free-text label carries over; the classroom-scoped foreign keys do not.
    assert body["topic"] == "Biology"
    assert body["chapterId"] is None
    assert body["topicId"] is None


def test_duplicate_into_a_classroom_the_teacher_does_not_teach_is_rejected(client, token_factory):
    teacher_a = token_factory("teacher")
    teacher_b = token_factory("teacher", user_id=TEACHER_B, school_id=SCHOOL_B)
    classroom_a = make_classroom(client, teacher_a)
    classroom_b = client.post(
        "/api/lms/classrooms",
        json={"name": "Someone Else's Class", "subject": "Maths"},
        cookies=cookie(teacher_b),
    ).json()
    source = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/coursework",
        json={"title": "Essay 1", "type": "assignment"},
        cookies=cookie(teacher_a),
    ).json()

    dup = client.post(
        f"/api/lms/coursework/{source['id']}/duplicate",
        json={"classroomId": classroom_b["id"]},
        cookies=cookie(teacher_a),
    )
    # 404 rather than 403 here — get_visible_classroom is school-scoped, so
    # a classroom in another school never confirms its own existence to a
    # teacher outside it (same "don't distinguish not-found from wrong-school"
    # convention used elsewhere in this service).
    assert dup.status_code in (403, 404), dup.text


def test_duplicate_carries_over_a_still_ready_quiz_link(client, token_factory, monkeypatch):
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    source = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()
    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz(school_id=source["schoolId"]))
    client.post(
        f"/api/lms/coursework/{source['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )

    dup = client.post(f"/api/lms/coursework/{source['id']}/duplicate", cookies=cookie(teacher))
    assert dup.status_code == 201, dup.text
    assert dup.json()["quizId"] == "quiz-1"


def test_duplicate_drops_a_quiz_link_that_is_no_longer_ready(client, token_factory, monkeypatch):
    """A duplicate re-validates the quiz at copy time, not just at the
    original link time — the source quiz may have been pulled from review
    since. Dropping it (rather than 400ing the whole duplicate) matches
    D17: duplication should never fail outright over a stale sub-field."""
    import coursework

    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    source = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Quiz Bridge", "type": "quiz", "maxPoints": 20},
        cookies=cookie(teacher),
    ).json()
    monkeypatch.setattr(coursework.clients, "lookup_quiz", _stub_quiz(school_id=source["schoolId"]))
    client.post(
        f"/api/lms/coursework/{source['id']}/link-quiz",
        json={"quizId": "quiz-1"},
        cookies=cookie(teacher),
    )
    # The quiz was un-approved since linking.
    monkeypatch.setattr(
        coursework.clients,
        "lookup_quiz",
        _stub_quiz(school_id=source["schoolId"], status_="pending_review"),
    )

    dup = client.post(f"/api/lms/coursework/{source['id']}/duplicate", cookies=cookie(teacher))
    assert dup.status_code == 201, dup.text
    assert dup.json()["quizId"] is None


# ── T2.2 — reuse a rubric across classrooms ──────────────────────────────────

def test_rubric_attaches_across_classrooms_in_the_same_school(client, token_factory):
    teacher = token_factory("teacher")
    classroom_a = make_classroom(client, teacher, name="Section A")
    classroom_b = make_classroom(client, teacher, name="Section B")
    rubric = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/rubrics",
        json={"title": "Essay rubric", "criteria": [{"criterion": "Structure", "maxPoints": 5}]},
        cookies=cookie(teacher),
    ).json()
    coursework_b = client.post(
        f"/api/lms/classrooms/{classroom_b['id']}/coursework",
        json={"title": "Essay in Section B", "maxPoints": 5},
        cookies=cookie(teacher),
    ).json()

    attached = client.post(
        f"/api/lms/rubrics/{rubric['id']}/attach",
        json={"courseworkId": coursework_b["id"]},
        cookies=cookie(teacher),
    )
    assert attached.status_code == 200, attached.text

    detail = client.get(f"/api/lms/coursework/{coursework_b['id']}", cookies=cookie(teacher)).json()
    assert detail["rubricCriteria"] == [{"criterion": "Structure", "maxPoints": 5, "description": None}]


def test_rubric_attach_across_schools_is_still_rejected(client, token_factory):
    teacher_a = token_factory("teacher")
    teacher_b = token_factory("teacher", user_id=TEACHER_B, school_id=SCHOOL_B)
    classroom_a = make_classroom(client, teacher_a)
    classroom_b_other_school = client.post(
        "/api/lms/classrooms",
        json={"name": "Other School Class", "subject": "Science"},
        cookies=cookie(teacher_b),
    ).json()
    rubric = client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/rubrics",
        json={"title": "Essay rubric", "criteria": [{"criterion": "Structure", "maxPoints": 5}]},
        cookies=cookie(teacher_a),
    ).json()

    # teacher_a doesn't teach classroom_b_other_school at all, so the
    # coursework-ownership check rejects first (403) — same boundary
    # get_owned_coursework already enforces everywhere else.
    coursework_other = client.post(
        f"/api/lms/classrooms/{classroom_b_other_school['id']}/coursework",
        json={"title": "Essay", "maxPoints": 5},
        cookies=cookie(teacher_b),
    ).json()
    attached = client.post(
        f"/api/lms/rubrics/{rubric['id']}/attach",
        json={"courseworkId": coursework_other["id"]},
        cookies=cookie(teacher_a),
    )
    assert attached.status_code in (403, 404), attached.text


def test_my_rubrics_lists_across_classrooms_but_not_other_teachers(client, token_factory):
    teacher = token_factory("teacher")
    # Same school as `teacher`, different person — token_factory defaults
    # school_id to SCHOOL_A, so only user_id needs overriding here.
    other_teacher = token_factory("teacher", user_id=TEACHER_B)
    classroom_a = make_classroom(client, teacher, name="Section A")
    classroom_b = make_classroom(client, teacher, name="Section B")
    client.post(
        f"/api/lms/classrooms/{classroom_a['id']}/rubrics",
        json={"title": "Rubric A", "criteria": [{"criterion": "Structure", "maxPoints": 5}]},
        cookies=cookie(teacher),
    )
    client.post(
        f"/api/lms/classrooms/{classroom_b['id']}/rubrics",
        json={"title": "Rubric B", "criteria": [{"criterion": "Evidence", "maxPoints": 5}]},
        cookies=cookie(teacher),
    )
    # A second teacher, same school, teaching neither of the above classrooms.
    other_classroom = make_classroom(client, other_teacher, name="Other Teacher's Class")
    client.post(
        f"/api/lms/classrooms/{other_classroom['id']}/rubrics",
        json={"title": "Not Mine", "criteria": [{"criterion": "X", "maxPoints": 5}]},
        cookies=cookie(other_teacher),
    )

    mine = client.get("/api/lms/rubrics/mine", cookies=cookie(teacher)).json()
    titles = {r["title"] for r in mine["rubrics"]}
    assert titles == {"Rubric A", "Rubric B"}
