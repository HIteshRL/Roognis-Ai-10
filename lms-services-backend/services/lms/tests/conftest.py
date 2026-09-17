import os
import tempfile

import jwt
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "test-lms-secret-with-enough-length")
os.environ.setdefault("LMS_DB_SCHEMA", "")
os.environ.setdefault("LMS_TEST_MODE", "true")
os.environ.setdefault("FILE_STORAGE_PATH", tempfile.mkdtemp(prefix="roognis-lms-tests-"))
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-token")

from database import Base, engine  # noqa: E402
from main import app  # noqa: E402

SCHOOL_A = "22222222-2222-2222-2222-222222222222"
SCHOOL_B = "44444444-4444-4444-4444-444444444444"
TEACHER_A = "11111111-1111-1111-1111-111111111111"
TEACHER_B = "55555555-5555-5555-5555-555555555555"
STUDENT_A = "33333333-3333-3333-3333-333333333333"
STUDENT_B = "66666666-6666-6666-6666-666666666666"


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def token_factory():
    defaults = {"teacher": TEACHER_A, "student": STUDENT_A}

    def create_token(role: str = "teacher", user_id: str | None = None, school_id: str = SCHOOL_A, name: str | None = None, **overrides):
        payload = {
            "userId": user_id or defaults.get(role, TEACHER_A),
            "role": role,
            "schoolId": school_id,
            "name": name if name is not None else f"Test {role.title()}",
            **overrides,
        }
        return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")

    return create_token


@pytest.fixture()
def internal_headers():
    return {"X-Internal-Service-Token": os.environ["INTERNAL_SERVICE_TOKEN"]}


@pytest.fixture(autouse=True)
def auth_service_links(monkeypatch):
    # Unit suites isolate the external Auth service. Dedicated guardian tests
    # override this stub to characterize live revocation.
    import guardians
    monkeypatch.setattr(guardians, "linked_student_ids", lambda user: user.student_ids)
