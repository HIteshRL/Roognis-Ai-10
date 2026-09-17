"""Sprint 3, S3.0.1: regression coverage for the collapsed classroom-authz
gate (`membership.require_teacher_of`).

Before this collapse, `classrooms.get_owned_classroom` granted access purely
on `classroom.teacher_id == user.user_id`, with no check that `user.role`
was actually `"teacher"` — safe in production only because `teacher_id` is
never set to anything but a teacher's own id. `membership.require_teacher_of`
(the survivor) checks role explicitly. This test pins that behaviour so a
future refactor can't silently drop it back to the looser check.
"""
import pytest
from fastapi import HTTPException

from auth import AuthUser
from conftest import SCHOOL_A, TEACHER_A
from database import SessionLocal
from membership import require_teacher_of


def cookie(token):
    return {"jwt": token}


def test_role_check_survives_the_authz_collapse(client, token_factory):
    teacher = token_factory("teacher")
    created = client.post(
        "/api/lms/classrooms",
        json={"name": "Class 8 Science", "subject": "Science"},
        cookies=cookie(teacher),
    )
    assert created.status_code == 201, created.text
    classroom_id = created.json()["id"]

    # Same user_id as the owning teacher, but a non-teacher role — must be
    # rejected on role alone, not silently admitted by the id match.
    impostor = AuthUser(user_id=TEACHER_A, role="student", school_id=SCHOOL_A)

    db = SessionLocal()
    try:
        with pytest.raises(HTTPException) as exc_info:
            require_teacher_of(db, impostor, classroom_id)
        assert exc_info.value.status_code == 403
    finally:
        db.close()


def test_owner_of_correct_role_still_admitted(client, token_factory):
    teacher = token_factory("teacher")
    created = client.post(
        "/api/lms/classrooms",
        json={"name": "Class 8 Science", "subject": "Science"},
        cookies=cookie(teacher),
    )
    classroom_id = created.json()["id"]

    real_teacher = AuthUser(user_id=TEACHER_A, role="teacher", school_id=SCHOOL_A)

    db = SessionLocal()
    try:
        classroom = require_teacher_of(db, real_teacher, classroom_id)
        assert classroom.id == classroom_id
    finally:
        db.close()
