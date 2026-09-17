from datetime import datetime, timezone
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from auth import AuthUser, get_current_user
from campaigns import process_campaign_projections
from config import Settings, get_settings
from database import Base, get_db
from main import app
from models import CampaignProjection, InterventionCampaign, InterventionDelivery


@pytest.fixture
def campaign_app():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = Session(engine)
    settings = Settings(
        internal_service_token="test-internal",
        gnn_service_url="",
        gnn_trainer_url="",
        kg_service_url="",
        decision_service_url="",
        campaign_projection_enabled=False,
    )
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_current_user] = lambda: AuthUser("student-a", "student", "school-a")
    yield TestClient(app), session, settings
    app.dependency_overrides.clear()
    session.close()


def trusted_event():
    return {
        "schemaVersion": 1,
        "eventId": str(uuid.uuid4()),
        "eventType": "written_answer_scored",
        "source": "lms",
        "studentId": "student-a",
        "schoolId": "school-a",
        "itemId": "revision-a",
        "conceptId": "concept:cells",
        "clientTsMono": 0,
        "clientTsWall": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "scoreNormalized": 0.3,
            "resultRef": "grade-a",
            "gradingAuthority": "lms-service",
            "difficulty": "medium",
            "chapterId": "chapter-a",
            "courseworkId": "work-a",
        },
    }


def test_one_campaign_projects_to_surfaces_and_completion_closes_all(campaign_app):
    client, db, _ = campaign_app
    response = client.post(
        "/api/psv/internal/events/batch",
        headers={"X-Internal-Service-Token": "test-internal"},
        json={"events": [trusted_event()]},
    )
    assert response.status_code == 202, response.text
    campaign = db.scalar(select(InterventionCampaign))
    assert campaign is not None
    assert campaign.concept_id == "concept:cells"
    assert campaign.chapter_id == "chapter-a"
    # §8 correlation id threads event → snapshot → campaign.
    assert campaign.correlation_id == "grade-a"
    gap = client.get("/api/psv/v1/me/knowledge-gaps").json()["knowledgeGaps"][0]
    assert gap["correlationId"] == "grade-a"
    assert gap["retention"]["correlationId"] == "grade-a"

    portal = client.get("/api/psv/v1/me/interventions?surface=portal").json()["campaigns"]
    tutor = client.get("/api/psv/v1/me/interventions?surface=tutor&sessionId=session-a").json()["campaigns"]
    second_tutor = client.get("/api/psv/v1/me/interventions?surface=tutor&sessionId=session-a").json()["campaigns"]
    assert portal[0]["campaignId"] == campaign.id
    assert tutor[0]["campaignId"] == campaign.id
    assert second_tutor == []

    completed = client.post(
        f"/api/psv/v1/interventions/{campaign.id}/events",
        json={"surface": "portal", "eventType": "completed", "idempotencyKey": "complete-event-a"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    assert client.get("/api/psv/v1/me/interventions?surface=discover").json()["campaigns"] == []


def test_immediate_path_stats_report_sub_target_latency(campaign_app):
    client, _, _ = campaign_app
    headers = {"X-Internal-Service-Token": "test-internal"}
    assert client.post(
        "/api/psv/internal/events/batch", headers=headers, json={"events": [trusted_event()]},
    ).status_code == 202

    assert client.get("/api/psv/internal/immediate-path/stats").status_code == 401
    stats = client.get("/api/psv/internal/immediate-path/stats", headers=headers).json()
    assert stats["targetSeconds"] == 60
    assert stats["correlatedCampaigns"] == 1
    assert stats["withinTarget"] == 1
    assert stats["exceededTarget"] == 0
    assert 0 <= stats["latencySecondsMax"] < 60


def test_notification_projection_is_idempotent_and_records_delivery(campaign_app, monkeypatch):
    client, db, settings = campaign_app
    client.post(
        "/api/psv/internal/events/batch",
        headers={"X-Internal-Service-Token": "test-internal"},
        json={"events": [trusted_event()]},
    )
    calls = []

    class Response:
        def raise_for_status(self):
            return None

    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return Response()

    monkeypatch.setattr("campaigns.httpx.post", post)
    result = process_campaign_projections(db, settings)
    assert result["delivered"] == 1
    assert len(calls) == 1
    assert calls[0][1]["notifications"][0]["dedupeKey"].startswith("campaign-notification:")
    assert db.scalar(select(CampaignProjection)).status == "delivered"
    assert db.scalar(select(InterventionDelivery).where(
        InterventionDelivery.surface == "notifications",
    )) is not None
    assert process_campaign_projections(db, settings)["selected"] == 0
