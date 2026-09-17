from dataclasses import replace
from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
import main
from artifacts import BOOTSTRAP_ARTIFACT
from config import Settings, get_settings
from graph_models import KnowledgeGraphTemporalNetwork, PreferenceSignedGNN


@pytest.fixture
def serving(monkeypatch):
    settings = Settings(internal_service_token="test", gnn_lane="knowledge")
    monkeypatch.setattr(main, "settings", settings)
    main.app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_scoring_requires_internal_auth_and_correct_lane(serving):
    payload = {"studentId": "a", "concepts": [{"conceptId": "a", "features": [0.2, 0.2, 0.2, 0]}]}
    assert serving.post("/internal/gnn/v1/knowledge/score", json=payload).status_code == 401
    assert serving.post(
        "/internal/gnn/v1/preference/score",
        json={"studentId": "a", "graphVersion": "pref-hetero-v1",
              "nodes": [{"nodeId": "a", "nodeType": "topic", "features": [1]}]},
        headers={"X-Internal-Service-Token": "test"},
    ).status_code == 409


def test_promoted_model_still_cannot_control_low_coverage_or_stale_students(serving, monkeypatch):
    artifact = replace(BOOTSTRAP_ARTIFACT, promoted=True, promoted_at=datetime.now(timezone.utc))
    def models():
        return artifact, PreferenceSignedGNN(artifact), KnowledgeGraphTemporalNetwork(artifact)
    monkeypatch.setattr(main, "current_models", models)
    payload = {"studentId": "a", "concepts": [{"conceptId": "a", "features": [0.2, 0.2, 0.2, 0]}],
               "events": [{"conceptId": "a", "outcome": 1, "weight": 1}]}
    def score():
        return serving.post("/internal/gnn/v1/knowledge/score", json=payload, headers={"X-Internal-Service-Token": "test"}).json()
    assert score()["eligible"] is False
    assert score()["reason"] == "insufficient_coverage"
    artifact = replace(artifact, promoted_at=datetime.now(timezone.utc) - timedelta(days=10))
    assert score()["reason"] == "stale_model"


def test_invalid_reload_retains_previous_model(serving, monkeypatch, tmp_path):
    path = tmp_path / "broken.json"
    path.write_text('{"incomplete": true}')
    monkeypatch.setattr(main.settings, "gnn_model_artifact", str(path))
    monkeypatch.setattr(main, "artifact_mtime_ns", None)
    previous = main.artifact
    assert main.current_models()[0] is previous


def test_the_v1_preference_body_is_rejected_rather_than_silently_emptied(monkeypatch):
    """Without extra="forbid" a stale caller's `topics`/`interactions` would be
    dropped and every student would score against an empty graph — a broken
    deployment that looks like a working one."""
    settings = Settings(internal_service_token="test", gnn_lane="preference")
    monkeypatch.setattr(main, "settings", settings)
    main.app.dependency_overrides[get_settings] = lambda: settings
    client = TestClient(main.app)
    v1_body = {
        "studentId": "a",
        "topics": [{"topicId": "space", "features": [1, 0, 0, 0]}],
        "interactions": [{"topicId": "space", "stance": "LIKE"}],
        "edges": [],
    }
    response = client.post("/internal/gnn/v1/preference/score", json=v1_body,
                           headers={"X-Internal-Service-Token": "test"})
    assert response.status_code == 422
    main.app.dependency_overrides.clear()


def test_coverage_counts_only_the_students_own_signed_edges(monkeypatch):
    """Content-to-topic edges are shared across every student holding that topic;
    counting them would make a brand-new learner look well covered."""
    settings = Settings(internal_service_token="test", gnn_lane="preference",
                        gnn_min_preference_coverage=3)
    monkeypatch.setattr(main, "settings", settings)
    main.app.dependency_overrides[get_settings] = lambda: settings
    client = TestClient(main.app)
    body = {
        "studentId": "a", "graphVersion": "pref-hetero-v1",
        "nodes": [
            {"nodeId": "student:a", "nodeType": "student", "features": [1, 0, 0, 0]},
            {"nodeId": "space", "nodeType": "topic", "features": [1, 0, 0, 0]},
            {"nodeId": "art:1", "nodeType": "article", "features": [0, 1, 0, 0]},
        ],
        "edges": [
            {"fromId": "art:1", "toId": "space", "relationship": "CONTENT_COVERS"},
            {"fromId": "student:a", "toId": "space", "relationship": "STUDENT_PREFERS", "sign": 1},
        ],
    }
    result = client.post("/internal/gnn/v1/preference/score", json=body,
                         headers={"X-Internal-Service-Token": "test"}).json()
    assert result["coverage"] == 1, "only the STUDENT_PREFERS edge counts"
    assert result["eligible"] is False
    main.app.dependency_overrides.clear()
