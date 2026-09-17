import pytest

from config import Settings
from gnn_client import score_knowledge


class Response:
    def __init__(self, body=None):
        self.body = body or {"nodes": [], "edges": []}

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


def test_unknown_concept_never_reaches_the_gnn(monkeypatch):
    calls = []

    def post(url, **_kwargs):
        calls.append(url)
        return Response()

    monkeypatch.setattr("gnn_client.httpx.post", post)
    result = score_knowledge(
        Settings(internal_service_token="test"),
        student_id="student-1",
        concept_id="concept:unknown",
        baseline={"mastery": 0.4, "recall_stability": 0.4, "difficulty_readiness": 0.3, "confidence": 0.5},
        evidence=[object()],
    )
    assert result["eligible"] is False
    assert result["reason"] == "unknown_or_inactive_concept"
    assert len(calls) == 1


def test_theta_and_uncertainty_are_sent_as_bounded_knowledge_features(monkeypatch):
    requests = []

    def post(url, **kwargs):
        requests.append((url, kwargs.get("json")))
        if url.endswith("/api/kg/internal/subgraph"):
            return Response({"nodes": [{"nodeId": "concept:a", "kind": "Concept"}], "edges": []})
        return Response({"eligible": False, "scores": []})

    monkeypatch.setattr("gnn_client.httpx.post", post)
    score_knowledge(
        Settings(internal_service_token="test"),
        student_id="student-1",
        concept_id="concept:a",
        baseline={"mastery": 0.4, "recall_stability": 0.5, "difficulty_readiness": 0.3, "confidence": 0.6},
        retention={"predicted_recall_now": 0.72, "theta_mean_per_day": 0.6, "theta_std_dev": 0.3},
        evidence=[],
    )
    features = requests[1][1]["concepts"][0]["features"]
    assert features == pytest.approx([0.4, 0.72, 0.3, 0.6, 0.2, 0.1])
