from datetime import datetime, timezone
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from auth import AuthUser, get_current_user
from config import Settings, get_settings
from database import Base, get_db
from main import app
from models import LearningEvent, KnowledgeGapSnapshot
from service import recompute_student

@pytest.fixture
def boundary():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = Session(engine)
    settings = Settings(internal_service_token="test-internal", gnn_service_url="", gnn_trainer_url="", kg_service_url="", decision_service_url="")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_current_user] = lambda: AuthUser("student-a", "student", "school-a")
    yield TestClient(app), session, settings
    app.dependency_overrides.clear()
    session.close()

def event(**overrides):
    value = dict(schemaVersion=1, eventId=str(uuid.uuid4()), eventType="answer_submitted", source="quiz",
                 studentId="student-a", schoolId="school-a", itemId="question-a", conceptId="concept:fractions",
                 clientTsMono=1, clientTsWall=datetime.now(timezone.utc).isoformat(), payload={"answerPresent": True})
    value.update(overrides)
    return value

@pytest.mark.parametrize("payload,event_type", [
    ({"correct": True}, "answer_submitted"),
    ({"scoreNormalized": 1, "gradingAuthority": "quiz-service", "_verified": True}, "written_answer_scored"),
    ({"grade": "easy"}, "flashcard_review_completed"),
    ({"nested": {"scoreNormalized": 1}}, "answer_submitted"),
])
def test_browser_cannot_forge_evidence(boundary, payload, event_type):
    client, db, _ = boundary
    response = client.post("/api/psv/v1/events/batch", json={"events": [event(payload=payload, eventType=event_type)]})
    assert response.status_code == 422
    assert db.scalar(select(LearningEvent)) is None

def test_trusted_outcome_to_snapshot_with_retry(boundary):
    client, db, settings = boundary
    row = event(payload={"correct": False, "scoreNormalized": 0, "resultRef": "attempt-a", "gradingAuthority": "quiz-service", "difficulty": "medium"})
    assert client.post("/api/psv/internal/events/batch", json={"events": [row]}).status_code == 401
    headers = {"X-Internal-Service-Token": "test-internal"}
    first = client.post("/api/psv/internal/events/batch", headers=headers, json={"events": [row]})
    assert first.status_code == 202
    assert first.json()["accepted"] == 1
    duplicate = client.post("/api/psv/internal/events/batch", headers=headers, json={"events": [row]})
    assert duplicate.json()["deduplicated"] == 1
    assert recompute_student(db, settings, student_id="student-a", school_id="school-a") == 1
    snapshot = db.scalar(select(KnowledgeGapSnapshot))
    assert snapshot.evidence_count == 1
    assert snapshot.decision_source == "baseline"
    assert snapshot.mastery < 0.25
    assert client.get("/api/psv/v1/me/knowledge-gaps").json()["knowledgeGaps"][0]["nextDifficulty"] == "simple"

def test_browser_events_are_recorded_but_never_scored(boundary):
    client, db, settings = boundary
    row = event()
    assert client.post("/api/psv/v1/events/batch", json={"events": [row, row]}).json()["deduplicated"] == 1
    assert recompute_student(db, settings, student_id="student-a", school_id="school-a") == 0

def test_account_switch_cannot_deliver_another_students_queue(boundary):
    client, _, _ = boundary
    assert client.post("/api/psv/v1/events/batch", json={"events": [event(studentId="student-b")]}).status_code == 403

def test_teacher_cannot_read_private_student_snapshot(boundary):
    client, _, _ = boundary
    app.dependency_overrides[get_current_user] = lambda: AuthUser("teacher-a", "teacher", "school-a")
    assert client.get("/api/psv/v1/me/knowledge-gaps").status_code == 403
