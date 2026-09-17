from fastapi.testclient import TestClient

from config import Settings, get_settings
from trainer_main import app


def test_training_worker_rejects_the_other_graph_lane(tmp_path):
    app.dependency_overrides[get_settings] = lambda: Settings(
        internal_service_token="secret",
        gnn_lane="preference",
        gnn_model_artifact=str(tmp_path / "model.json"),
    )
    try:
        response = TestClient(app).post(
            "/internal/gnn/v1/train",
            headers={"X-Internal-Service-Token": "secret"},
            json={
                "lane": "knowledge",
                "modelVersion": "knowledge-test",
                "samples": [{"targetConceptId": "concept:test"}],
            },
        )
        assert response.status_code == 409
        assert not (tmp_path / "model.json").exists()
    finally:
        app.dependency_overrides.clear()


def test_training_worker_runs_gate_without_promoting_tiny_corpus(tmp_path):
    artifact = tmp_path / "model.json"
    app.dependency_overrides[get_settings] = lambda: Settings(
        internal_service_token="secret",
        gnn_lane="preference",
        gnn_model_artifact=str(artifact),
    )
    try:
        response = TestClient(app).post(
            "/internal/gnn/v1/train",
            headers={"X-Internal-Service-Token": "secret"},
            json={
                "lane": "preference",
                "modelVersion": "preference-test",
                "samples": [{
                    "nodes": [
                        {"nodeId": "student:a", "nodeType": "student", "features": [1, 0, 0, 0]},
                        {
                            "nodeId": "space",
                            "nodeType": "topic",
                            "features": [1, 0, 0, 1],
                            "baselineScore": 0,
                        },
                    ],
                    "edges": [],
                    "targetTopicId": "space",
                    "targetStance": "LIKE",
                }],
            },
        )
        assert response.status_code == 200
        assert response.json()["promoted"] is False
        assert response.json()["metrics"]["heldOutEvents"] == 1
        assert not artifact.exists()
    finally:
        app.dependency_overrides.clear()
