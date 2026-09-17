from conftest import SCHOOL_B


def cookie(token):
    return {"jwt": token}


def make_term(client, teacher, **overrides):
    body = {
        "name": "2026-27",
        "startDate": "2026-06-01T00:00:00Z",
        "endDate": "2027-04-30T00:00:00Z",
        **overrides,
    }
    res = client.post("/api/lms/terms", json=body, cookies=cookie(teacher))
    assert res.status_code == 201, res.text
    return res.json()


def test_requires_auth(client):
    assert client.get("/api/lms/terms").status_code == 401


def test_student_cannot_create_term(client, token_factory):
    res = client.post(
        "/api/lms/terms",
        json={"name": "X", "startDate": "2026-01-01T00:00:00Z", "endDate": "2026-06-01T00:00:00Z"},
        cookies=cookie(token_factory("student")),
    )
    assert res.status_code == 403


def test_end_date_must_be_after_start_date(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/terms",
        json={"name": "X", "startDate": "2026-06-01T00:00:00Z", "endDate": "2026-01-01T00:00:00Z"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 422


def test_create_and_list_terms_school_scoped(client, token_factory):
    teacher = token_factory("teacher")
    other_school_teacher = token_factory("teacher", school_id=SCHOOL_B)

    term = make_term(client, teacher)
    assert term["isCurrent"] is False

    make_term(client, other_school_teacher, name="Other School Term")

    listed = client.get("/api/lms/terms", cookies=cookie(teacher)).json()["terms"]
    assert [t["name"] for t in listed] == ["2026-27"]


def test_only_one_current_term_per_school(client, token_factory):
    teacher = token_factory("teacher")
    first = make_term(client, teacher, name="Term 1", isCurrent=True)
    second = make_term(
        client,
        teacher,
        name="Term 2",
        startDate="2027-06-01T00:00:00Z",
        endDate="2028-04-30T00:00:00Z",
        isCurrent=True,
    )

    listed = {t["id"]: t["isCurrent"] for t in client.get("/api/lms/terms", cookies=cookie(teacher)).json()["terms"]}
    assert listed[first["id"]] is False
    assert listed[second["id"]] is True

    # Flipping the first back to current un-sets the second.
    client.patch(f"/api/lms/terms/{first['id']}", json={"isCurrent": True}, cookies=cookie(teacher))
    listed = {t["id"]: t["isCurrent"] for t in client.get("/api/lms/terms", cookies=cookie(teacher)).json()["terms"]}
    assert listed[first["id"]] is True
    assert listed[second["id"]] is False


def test_update_term_rejects_bad_date_order(client, token_factory):
    teacher = token_factory("teacher")
    term = make_term(client, teacher)
    res = client.patch(
        f"/api/lms/terms/{term['id']}",
        json={"startDate": "2027-06-01T00:00:00Z"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_cross_school_term_is_404(client, token_factory):
    teacher = token_factory("teacher")
    intruder = token_factory("teacher", school_id=SCHOOL_B)
    term = make_term(client, teacher)

    res = client.patch(f"/api/lms/terms/{term['id']}", json={"name": "Hijacked"}, cookies=cookie(intruder))
    assert res.status_code == 404

    res = client.delete(f"/api/lms/terms/{term['id']}", cookies=cookie(intruder))
    assert res.status_code == 404


def test_delete_term_orphans_classroom_instead_of_blocking(client, token_factory):
    teacher = token_factory("teacher")
    term = make_term(client, teacher)
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Class 8 Science", "subject": "Science", "termId": term["id"]},
        cookies=cookie(teacher),
    ).json()
    assert classroom["termId"] == term["id"]

    delete = client.delete(f"/api/lms/terms/{term['id']}", cookies=cookie(teacher))
    assert delete.status_code == 200

    refreshed = client.get(f"/api/lms/classrooms/{classroom['id']}", cookies=cookie(teacher)).json()
    assert refreshed["termId"] is None


def test_create_classroom_with_unknown_term_is_rejected(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/classrooms",
        json={"name": "X", "subject": "Y", "termId": "does-not-exist"},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_create_classroom_with_other_schools_term_is_rejected(client, token_factory):
    teacher = token_factory("teacher")
    other_school_teacher = token_factory("teacher", school_id=SCHOOL_B)
    foreign_term = make_term(client, other_school_teacher)

    res = client.post(
        "/api/lms/classrooms",
        json={"name": "X", "subject": "Y", "termId": foreign_term["id"]},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_list_classrooms_filters_by_term(client, token_factory):
    teacher = token_factory("teacher")
    term_a = make_term(client, teacher, name="Term A")
    term_b = make_term(
        client,
        teacher,
        name="Term B",
        startDate="2027-06-01T00:00:00Z",
        endDate="2028-04-30T00:00:00Z",
    )
    client.post(
        "/api/lms/classrooms",
        json={"name": "Class A", "subject": "Science", "termId": term_a["id"]},
        cookies=cookie(teacher),
    )
    client.post(
        "/api/lms/classrooms",
        json={"name": "Class B", "subject": "Math", "termId": term_b["id"]},
        cookies=cookie(teacher),
    )
    client.post(
        "/api/lms/classrooms",
        json={"name": "Class C (no term)", "subject": "Art"},
        cookies=cookie(teacher),
    )

    all_classrooms = client.get("/api/lms/classrooms", cookies=cookie(teacher)).json()["classrooms"]
    assert len(all_classrooms) == 3

    filtered = client.get(
        f"/api/lms/classrooms?termId={term_a['id']}", cookies=cookie(teacher)
    ).json()["classrooms"]
    assert [c["name"] for c in filtered] == ["Class A"]


def test_update_classroom_term(client, token_factory):
    teacher = token_factory("teacher")
    term = make_term(client, teacher)
    classroom = client.post(
        "/api/lms/classrooms",
        json={"name": "Class 8 Science", "subject": "Science"},
        cookies=cookie(teacher),
    ).json()
    assert classroom["termId"] is None

    updated = client.patch(
        f"/api/lms/classrooms/{classroom['id']}",
        json={"termId": term["id"]},
        cookies=cookie(teacher),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["termId"] == term["id"]
