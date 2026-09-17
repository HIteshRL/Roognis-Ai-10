"""Sprint 4, P4 — teacher next-actions (T4.1): `GET /teacher/todo`, spanning
every classroom a teacher owns or co-teaches in one request.

The correlation risk here is the same class of bug
`test_bulk_stats_correlation.py` already guards against for a single
classroom's batch — a value computed against the *wrong* row — except the
wrong-row risk here is a wrong *classroom*: `submission_stats_bulk`,
`assigned_count_bulk`, and `build_missing_work_bulk` were all rewritten
from a single scalar `classroom_id` to a per-item classroom correlation
specifically for this endpoint. Every stats-bearing test below therefore
creates at least two classrooms with deliberately different rosters/counts
and asserts each stays scoped to its own classroom, never the other's.
"""
from conftest import STUDENT_A, STUDENT_B

STUDENT_C = "77777777-7777-7777-7777-777777777777"
TEACHER_B = "55555555-5555-5555-5555-555555555555"


def cookie(token):
    return {"jwt": token}


def make_classroom(client, teacher, **overrides):
    body = {"name": "Class", "subject": "Science", **overrides}
    res = client.post("/api/lms/classrooms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def _stub_lookup(user_id, name="Co Teacher", role="teacher"):
    def _lookup(settings, email, school_id):
        return {"userId": user_id, "name": name, "role": role, "schoolId": school_id}

    return _lookup


def test_todo_stats_are_not_swapped_between_classrooms(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id=STUDENT_B)

    class_a = make_classroom(client, teacher, name="Class A")
    class_b = make_classroom(client, teacher, name="Class B")
    client.post("/api/lms/enrollments/join", json={"joinCode": class_a["joinCode"]}, cookies=cookie(student_a))
    client.post("/api/lms/enrollments/join", json={"joinCode": class_b["joinCode"]}, cookies=cookie(student_b))

    cw_a = client.post(
        f"/api/lms/classrooms/{class_a['id']}/coursework", json={"title": "HW A", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{cw_a['id']}/publish", cookies=cookie(teacher))
    client.post(f"/api/lms/coursework/{cw_a['id']}/submit", json={"text": "done"}, cookies=cookie(student_a))

    cw_b = client.post(
        f"/api/lms/classrooms/{class_b['id']}/coursework", json={"title": "HW B", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{cw_b['id']}/publish", cookies=cookie(teacher))
    # student_b (Class B's only student) never submits — HW B stays fully missing.

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher))
    assert todo.status_code == 200, todo.text
    by_id = {item["courseworkId"]: item for item in todo.json()["coursework"]}

    assert by_id[cw_a["id"]]["stats"]["assignedCount"] == 1
    assert by_id[cw_a["id"]]["stats"]["turnedIn"] == 1
    assert by_id[cw_b["id"]]["stats"]["assignedCount"] == 1
    assert by_id[cw_b["id"]]["stats"]["turnedIn"] == 0


def test_todo_targeted_assigned_count_correlates_per_classroom(client, token_factory):
    """Hits assigned_count_bulk's targeted-item join specifically: two
    classrooms each with a `target_mode == 'students'` item naming a
    different subset of their own (disjoint) rosters. A classroom-blind
    join would either double-count both items' targets or attribute one
    classroom's targeted students to the other's item."""
    teacher = token_factory("teacher")
    student_a1 = token_factory("student")
    student_a2 = token_factory("student", user_id=STUDENT_C)
    student_b = token_factory("student", user_id=STUDENT_B)

    class_a = make_classroom(client, teacher, name="Class A")
    class_b = make_classroom(client, teacher, name="Class B")
    for tok, cls in ((student_a1, class_a), (student_a2, class_a), (student_b, class_b)):
        client.post("/api/lms/enrollments/join", json={"joinCode": cls["joinCode"]}, cookies=cookie(tok))

    cw_a = client.post(
        f"/api/lms/classrooms/{class_a['id']}/coursework", json={"title": "Targeted A", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    # Targets only one of Class A's two students — STUDENT_A (the default
    # id token_factory gives student_a1, see conftest.py).
    client.post(
        f"/api/lms/coursework/{cw_a['id']}/publish",
        json={"targetMode": "students", "studentIds": [STUDENT_A]},
        cookies=cookie(teacher),
    )

    cw_b = client.post(
        f"/api/lms/classrooms/{class_b['id']}/coursework", json={"title": "All of B", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{cw_b['id']}/publish", cookies=cookie(teacher))

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher)).json()
    by_id = {item["courseworkId"]: item for item in todo["coursework"]}

    assert by_id[cw_a["id"]]["stats"]["assignedCount"] == 1, "targeted item must count only its named student"
    assert by_id[cw_b["id"]]["stats"]["assignedCount"] == 1, "Class B's untargeted item must use its own roster"


def test_todo_missing_work_scoped_per_classroom(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id=STUDENT_B)

    class_a = make_classroom(client, teacher, name="Class A")
    class_b = make_classroom(client, teacher, name="Class B")
    client.post("/api/lms/enrollments/join", json={"joinCode": class_a["joinCode"]}, cookies=cookie(student_a))
    client.post("/api/lms/enrollments/join", json={"joinCode": class_b["joinCode"]}, cookies=cookie(student_b))

    past_due = "2020-01-01T00:00:00Z"
    cw_a = client.post(
        f"/api/lms/classrooms/{class_a['id']}/coursework",
        json={"title": "Overdue A", "type": "assignment", "dueAt": past_due},
        cookies=cookie(teacher),
    ).json()
    client.post(f"/api/lms/coursework/{cw_a['id']}/publish", cookies=cookie(teacher))
    # Class B has coursework, but nothing overdue.
    client.post(
        f"/api/lms/classrooms/{class_b['id']}/coursework", json={"title": "Not due", "type": "assignment"},
        cookies=cookie(teacher),
    )

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher)).json()
    missing = todo["missingWork"]
    assert missing["totalMissing"] == 1
    assert len(missing["items"]) == 1
    item = missing["items"][0]
    assert item["classroomId"] == class_a["id"]
    assert item["courseworkId"] == cw_a["id"]
    assert item["missingStudents"] == [{"studentId": STUDENT_A, "studentName": "Test Student"}]


def test_todo_pending_enrollments_scoped_per_classroom(client, token_factory):
    teacher = token_factory("teacher")
    student_a = token_factory("student")
    student_b = token_factory("student", user_id=STUDENT_B)

    class_a = make_classroom(client, teacher, name="Class A", requireApproval=True)
    class_b = make_classroom(client, teacher, name="Class B", requireApproval=True)
    client.post("/api/lms/enrollments/join", json={"joinCode": class_a["joinCode"]}, cookies=cookie(student_a))
    client.post("/api/lms/enrollments/join", json={"joinCode": class_b["joinCode"]}, cookies=cookie(student_b))

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher)).json()
    by_classroom = {row["classroomId"]: row["count"] for row in todo["pendingEnrollments"]}
    assert by_classroom.get(class_a["id"]) == 1
    assert by_classroom.get(class_b["id"]) == 1


def test_todo_includes_drafts_and_scheduled_items(client, token_factory):
    teacher = token_factory("teacher")
    classroom = make_classroom(client, teacher)
    draft = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "Never published", "type": "assignment"},
        cookies=cookie(teacher),
    ).json()
    scheduled = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Publishing soon", "type": "assignment", "scheduledFor": "2099-01-01T00:00:00Z"},
        cookies=cookie(teacher),
    ).json()

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher)).json()
    by_id = {item["courseworkId"]: item for item in todo["coursework"]}

    assert by_id[draft["id"]]["status"] == "draft"
    assert by_id[draft["id"]]["stats"] is None
    assert by_id[scheduled["id"]]["status"] == "scheduled"
    assert by_id[scheduled["id"]]["scheduledFor"] is not None


def test_todo_material_has_no_stats_and_other_teachers_classes_are_excluded(client, token_factory):
    teacher_a = token_factory("teacher")
    teacher_b = token_factory("teacher", user_id="88888888-8888-8888-8888-888888888888")

    class_a = make_classroom(client, teacher_a, name="Teacher A's class")
    class_b = make_classroom(client, teacher_b, name="Teacher B's class")

    material = client.post(
        f"/api/lms/classrooms/{class_a['id']}/coursework", json={"title": "Reading", "type": "material"},
        cookies=cookie(teacher_a),
    ).json()
    client.post(f"/api/lms/coursework/{material['id']}/publish", cookies=cookie(teacher_a))
    other_cw = client.post(
        f"/api/lms/classrooms/{class_b['id']}/coursework", json={"title": "Not mine", "type": "assignment"},
        cookies=cookie(teacher_b),
    ).json()

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(teacher_a)).json()
    by_id = {item["courseworkId"]: item for item in todo["coursework"]}
    # A published material is still listed (the schedule panel needs every
    # classroom's due-today items regardless of type) but carries no stats —
    # nothing to grade — leaving the "has a signal" filtering to the caller.
    assert by_id[material["id"]]["stats"] is None
    assert other_cw["id"] not in by_id, "another teacher's coursework must never leak into this teacher's todo"


def test_todo_includes_co_teachers_classes(client, token_factory, monkeypatch):
    """list_teacher_classrooms is already co-teacher-aware (Sprint 3); the
    to-do must inherit that or a co-teacher loses visibility into work they
    can actually grade."""
    import co_teachers

    owner = token_factory("teacher")
    co_teacher_user = token_factory("teacher", user_id=TEACHER_B)
    classroom = make_classroom(client, owner)
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework", json={"title": "Shared work", "type": "assignment"},
        cookies=cookie(owner),
    ).json()

    monkeypatch.setattr(co_teachers.clients, "lookup_teacher_by_email", _stub_lookup(TEACHER_B))
    added = client.post(
        f"/api/lms/classrooms/{classroom['id']}/co-teachers",
        json={"email": "coteacher@example.com"},
        cookies=cookie(owner),
    )
    assert added.status_code == 201, added.text

    todo = client.get("/api/lms/teacher/todo", cookies=cookie(co_teacher_user)).json()
    ids = {item["courseworkId"] for item in todo["coursework"]}
    assert coursework["id"] in ids
