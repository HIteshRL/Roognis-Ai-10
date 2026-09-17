from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from config import Settings
from training_client import build_knowledge_training_samples, train_knowledge_model


def event(event_id: str, outcome: bool, observed_at: datetime):
    return SimpleNamespace(
        event_id=event_id,
        event_type="answer_submitted",
        concept_id="concept:v1:fractions",
        student_id="student-1",
        payload={"_verified": True, "scoreNormalized": float(outcome), "correct": outcome, "difficulty": "medium"},
        client_ts_wall=observed_at,
    )


def graph(_concept_id: str):
    return {
        "nodes": [
            {"nodeId": "concept:v1:fractions", "kind": "Concept"},
            {"nodeId": "concept:v1:division", "kind": "Concept"},
        ],
        "edges": [{
            "fromNodeId": "concept:v1:division",
            "toNodeId": "concept:v1:fractions",
        }],
    }


def test_training_sample_holds_out_the_latest_outcome():
    now = datetime.now(timezone.utc)
    samples = build_knowledge_training_samples([
        event("evidence-1", False, now - timedelta(days=1)),
        event("evidence-2", True, now),
    ], graph_loader=graph)

    assert len(samples) == 1
    assert samples[0]["targetOutcome"] == 1.0
    assert samples[0]["targetEventId"] == "evidence-2"
    assert [row["outcome"] for row in samples[0]["events"]] == [0.0]
    assert samples[0]["edges"] == [{
        "fromId": "concept:v1:division",
        "toId": "concept:v1:fractions",
        "relationship": "PREREQUISITE",
    }]


def test_unknown_concepts_are_not_training_labels():
    now = datetime.now(timezone.utc)
    samples = build_knowledge_training_samples([
        event("evidence-1", False, now - timedelta(days=1)),
        event("evidence-2", True, now),
    ], graph_loader=lambda _concept_id: {"nodes": [], "edges": []})
    assert samples == []


def test_training_worker_failure_keeps_baseline_path_available(monkeypatch):
    now = datetime.now(timezone.utc)
    monkeypatch.setattr("training_client.load_concept_subgraph", lambda _settings, concept_id: graph(concept_id))
    monkeypatch.setattr("training_client.httpx.post", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("down")))
    result = train_knowledge_model(
        Settings(internal_service_token="token", gnn_trainer_url="http://trainer"),
        [event("evidence-1", False, now - timedelta(days=1)), event("evidence-2", True, now)],
        model_version="knowledge-test",
    )
    assert result == {"attempted": True, "promoted": False, "reason": "trainer_unavailable"}
