import os
import shutil
import tempfile
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("FILE_STORAGE_PATH", str(Path(tempfile.gettempdir()) / "roognis-rag-tests"))
os.environ.setdefault("JWT_SECRET", "test-rag-secret-with-enough-length")
os.environ.setdefault("RAG_DB_SCHEMA", "")
os.environ.setdefault("RAG_TEST_MODE", "true")
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-token")

from main import app
from database import Base, engine


@pytest.fixture()
def client():
    storage_path = Path(os.environ["FILE_STORAGE_PATH"])
    if storage_path.exists():
        shutil.rmtree(storage_path)
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def token_factory():
    def create_token(role: str = "teacher", **overrides):
        payload = {
            "userId": "11111111-1111-1111-1111-111111111111",
            "role": role,
            "schoolId": "22222222-2222-2222-2222-222222222222",
            **overrides,
        }
        return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")

    return create_token


@pytest.fixture(autouse=True)
def isolated_lms_authorization(monkeypatch):
    import main
    from database import SessionLocal
    from models import Document
    from sqlalchemy import select
    def accessible(user):
        with SessionLocal() as db:
            return list(db.scalars(select(Document.id).where(Document.school_id==user.school_id)))
    monkeypatch.setattr(main,"student_document_ids",accessible)
