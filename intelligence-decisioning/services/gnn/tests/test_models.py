from datetime import datetime, timedelta, timezone

from artifacts import BOOTSTRAP_ARTIFACT, ModelArtifact, can_promote
from graph_models import KnowledgeGraphTemporalNetwork, PreferenceSignedGNN
from main import artifact_is_stale
from pretrain import pretrain_and_promote
from rollback import rollback
from schemas import KnowledgeConcept, KnowledgeEvent, PreferenceEdge, PreferenceNode


def _pref_nodes():
    return [
        PreferenceNode(nodeId="student:a", nodeType="student", features=[1, 0, 0, 0]),
        PreferenceNode(nodeId="space", nodeType="topic", features=[1, 0, 0, 0]),
        PreferenceNode(nodeId="sport", nodeType="topic", features=[0, 1, 0, 0]),
    ]


def _affinity(rows, topic):
    return next(row for row in rows if row["topicId"] == topic)["affinity"]


def test_a_dislike_yields_negative_affinity_and_a_like_yields_positive():
    """The half that was never tested.

    The predecessor's only signed test asserted a LIKE scores > 0, which a model
    that ignored sign entirely would also pass. Sign asymmetry has to be a
    property of the ARCHITECTURE, not of learned weights, so this runs on the
    untrained bootstrap artifact.
    """
    model = PreferenceSignedGNN(BOOTSTRAP_ARTIFACT)
    nodes = _pref_nodes()
    disliked = model.score(nodes, [
        PreferenceEdge(fromId="student:a", toId="sport", relationship="STUDENT_PREFERS", sign=-1, weight=2),
        PreferenceEdge(fromId="student:a", toId="space", relationship="STUDENT_PREFERS", sign=1, weight=2),
    ])
    assert _affinity(disliked, "sport") < 0 < _affinity(disliked, "space")


def test_sign_changes_aggregation_not_merely_final_pooling():
    """A third party's embedding must move when an unrelated edge flips sign.

    The predecessor applied sign once at pooling, so flipping an edge between two
    OTHER nodes could not change anything a third node saw. That model passes a
    pooling-only test and fails this one.
    """
    model = PreferenceSignedGNN(BOOTSTRAP_ARTIFACT)
    nodes = _pref_nodes()
    positive = model.embed(nodes, [
        PreferenceEdge(fromId="space", toId="sport", relationship="TOPIC_CO_OCCURS", sign=1),
    ])
    negative = model.embed(nodes, [
        PreferenceEdge(fromId="space", toId="sport", relationship="TOPIC_CO_OCCURS", sign=-1),
    ])
    assert not (positive["sport"] == negative["sport"]).all()


def test_balanced_and_unbalanced_paths_are_distinguished():
    """enemy-of-enemy and friend-of-friend must not collapse to the same vector.

    This is what separates SGCN from `sign x mean`: two negative hops is a
    balanced path, one negative hop is not.
    """
    model = PreferenceSignedGNN(BOOTSTRAP_ARTIFACT)
    nodes = _pref_nodes() + [PreferenceNode(nodeId="mid", nodeType="topic", features=[0, 0, 1, 0])]
    friend_of_friend = model.embed(nodes, [
        PreferenceEdge(fromId="space", toId="mid", relationship="TOPIC_CO_OCCURS", sign=1),
        PreferenceEdge(fromId="mid", toId="sport", relationship="TOPIC_CO_OCCURS", sign=1),
    ])
    enemy_of_enemy = model.embed(nodes, [
        PreferenceEdge(fromId="space", toId="mid", relationship="TOPIC_CO_OCCURS", sign=-1),
        PreferenceEdge(fromId="mid", toId="sport", relationship="TOPIC_CO_OCCURS", sign=-1),
    ])
    assert not (friend_of_friend["sport"] == enemy_of_enemy["sport"]).all()


def test_edge_direction_is_respected():
    """CONTENT_COVERS is not symmetric: an article covering a topic informs the
    topic, not the reverse."""
    model = PreferenceSignedGNN(BOOTSTRAP_ARTIFACT)
    nodes = _pref_nodes() + [PreferenceNode(nodeId="article:1", nodeType="article", features=[0, 0, 0, 1])]
    forward = model.embed(nodes, [
        PreferenceEdge(fromId="article:1", toId="space", relationship="CONTENT_COVERS"),
    ])
    isolated = model.embed(nodes, [])
    assert not (forward["space"] == isolated["space"]).all(), "target must absorb the source"
    assert (forward["article:1"] == isolated["article:1"]).all(), "source must not absorb the target"


def test_node_types_use_distinct_projections():
    """Identical raw features on different types must not land in one place —
    the v1 features[3] type-code hack is gone."""
    model = PreferenceSignedGNN(BOOTSTRAP_ARTIFACT)
    nodes = [
        PreferenceNode(nodeId="student:a", nodeType="student", features=[1, 0, 0, 0]),
        PreferenceNode(nodeId="t", nodeType="topic", features=[0.5, 0.5, 0, 0]),
        PreferenceNode(nodeId="a", nodeType="article", features=[0.5, 0.5, 0, 0]),
    ]
    embeddings = model.embed(nodes, [])
    assert not (embeddings["t"] == embeddings["a"]).all()


def test_temporal_knowledge_model_returns_bounded_trait_heads():
    model = KnowledgeGraphTemporalNetwork(BOOTSTRAP_ARTIFACT)
    scores = model.score(
        [KnowledgeConcept(conceptId="fractions", features=[0.4, 0.5, 0.3, 0.2], baselineMastery=0.4)],
        [KnowledgeEvent(conceptId="fractions", outcome=1, weight=1, difficulty=0.5)],
        [],
    )
    assert 0 <= scores[0]["mastery"] <= 1
    assert 0 <= scores[0]["recallStability"] <= 1


def test_promotion_requires_predictive_and_calibration_improvement():
    assert can_promote({
        "candidateMetric": 0.72,
        "baselineMetric": 0.68,
        "candidateCalibration": 0.08,
        "baselineCalibration": 0.1,
        "heldOutEvents": 100,
    })
    assert not can_promote({
        "candidateMetric": 0.65,
        "baselineMetric": 0.68,
        "candidateCalibration": 0.08,
        "baselineCalibration": 0.1,
        "heldOutEvents": 100,
    })
    assert not can_promote({
        "candidateMetric": 0.99,
        "baselineMetric": 0.50,
        "candidateCalibration": 0.01,
        "baselineCalibration": 0.50,
        "heldOutEvents": 3,
    })


def test_stale_promoted_model_becomes_ineligible():
    artifact = ModelArtifact(
        model_version="old-model",
        promoted=True,
        seed=1,
        metrics={},
        promoted_at=datetime.now(timezone.utc) - timedelta(days=10),
    )
    assert artifact_is_stale(artifact) is True


def test_atomic_rollback_restores_previous_manifest(tmp_path):
    current = tmp_path / "model.json"
    previous = tmp_path / "model.json.previous"
    current.write_text('{"modelVersion":"bad"}', encoding="utf-8")
    previous.write_text('{"modelVersion":"good"}', encoding="utf-8")
    rollback(current)
    assert current.read_text(encoding="utf-8") == '{"modelVersion":"good"}'


def test_pretraining_cannot_promote_when_baseline_is_better(tmp_path):
    output = tmp_path / "model.json"
    result = pretrain_and_promote(
        lane="preference",
        samples=[{
            "nodes": [
                {"nodeId": "student:a", "nodeType": "student", "features": [1, 0, 0, 0]},
                {"nodeId": "space", "nodeType": "topic", "features": [1, 0, 0, 1], "baselineScore": 1},
            ],
            "edges": [],
            "targetTopicId": "space",
            "targetStance": "LIKE",
        }],
        output=output,
        model_version="candidate-v1",
    )
    assert result["promoted"] is False
    assert result["metrics"]["heldOutEvents"] == 1
    assert not output.exists()


def test_invalid_pretraining_rows_do_not_count_as_held_out_events(tmp_path):
    result = pretrain_and_promote(
        lane="knowledge",
        samples=[{"targetConceptId": "missing"}],
        output=tmp_path / "model.json",
        model_version="candidate-invalid",
    )
    assert result["metrics"]["heldOutEvents"] == 0
def test_optimizer_changes_saved_weights_and_reload_reproduces_predictions(tmp_path):
    from artifacts import load_artifact
    from schemas import PreferenceScoreRequest
    samples = [{
        "splitGroup": f"student-{index}",
        "nodes": [
            {"nodeId": "student:a", "nodeType": "student", "features": [1, 0, 0, 0]},
            {"nodeId": "space", "nodeType": "topic", "features": [1, 0, 0, 1], "baselineScore": 0},
        ],
        "edges": [], "targetTopicId": "space", "targetStance": "LIKE" if index % 5 else "DISLIKE",
    } for index in range(160)]
    output = tmp_path / "trained.json"
    result = pretrain_and_promote(lane="preference", samples=samples, output=output, model_version="trained-test")
    assert result["metrics"]["trained"]
    assert result["metrics"]["weightsChanged"]
    assert result["metrics"]["trainingEvents"] + result["metrics"]["validationEvents"] + result["metrics"]["heldOutEvents"] == 160
    assert result["promoted"]
    artifact = load_artifact(str(output))
    assert artifact.weights and artifact.lane == "preference"
    model = PreferenceSignedGNN(artifact)
    restored = PreferenceSignedGNN(load_artifact(str(output)))
    request = PreferenceScoreRequest(
        studentId="a", graphVersion="pref-hetero-v1", nodes=samples[0]["nodes"],
    )
    assert model.score(request.nodes, []) == restored.score(request.nodes, [])
    assert artifact.architecture == "preference-hetero-signed-v1"


def test_seed_only_manifest_is_ineligible_even_when_marked_promoted(tmp_path):
    import json
    from artifacts import load_artifact
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps({"modelVersion": "legacy", "promoted": True, "seed": 1}))
    assert not load_artifact(str(path)).promoted


def test_duplicate_training_samples_do_not_inflate_test_coverage(tmp_path):
    sample = {
        "nodes": [
            {"nodeId": "student:a", "nodeType": "student", "features": [1, 0, 0, 0]},
            {"nodeId": "a", "nodeType": "topic", "features": [1]},
        ],
        "targetTopicId": "a", "targetStance": "LIKE",
    }
    result = pretrain_and_promote(lane="preference", samples=[sample] * 50, output=tmp_path / "bad.json", model_version="bad")
    assert result["metrics"]["heldOutEvents"] == 1
    assert not result["promoted"]


def test_prerequisite_attention_is_directed():
    from schemas import GraphEdge
    model = KnowledgeGraphTemporalNetwork(BOOTSTRAP_ARTIFACT)
    concepts = [KnowledgeConcept(conceptId="a", features=[1, 0, 0, 0]), KnowledgeConcept(conceptId="b", features=[0, 1, 0, 0])]
    no_edge = model._graph_attention(concepts, [])
    connected = model._graph_attention(concepts, [GraphEdge(fromId="a", toId="b", relationship="PREREQUISITE_OF")])
    import numpy as np
    assert np.allclose(no_edge["a"], connected["a"])
    assert not np.allclose(no_edge["b"], connected["b"])


def test_a_v1_architecture_artifact_is_rejected_rather_than_mis_loaded(tmp_path):
    """trainingMethod is an optimizer tag, not an architecture tag.

    A v1 preference model trained by the same SPSA optimizer would otherwise
    reach restore(), raise deep inside model construction, and be silently
    swapped for the bootstrap — which an operator cannot tell apart from having
    configured no model at all. It must be refused up front, with a reason.
    """
    import json
    from artifacts import load_artifact
    path = tmp_path / "v1.json"
    path.write_text(json.dumps({
        "modelVersion": "preference-old", "promoted": True, "seed": 1,
        "trainingMethod": "spsa-v1", "lane": "preference",
        "weights": {"w_self_1": [[0.1]]},
        "architecture": "preference-signed-graphsage-v0",
    }))
    artifact = load_artifact(str(path))
    assert artifact.promoted is False
    assert artifact.weights is None, "stale weights must never reach restore()"
    assert "architecture_mismatch" in artifact.rejected_reason
    # Still readable for audit.
    assert artifact.model_version == "preference-old"


def test_an_artifact_with_no_architecture_stamp_is_rejected(tmp_path):
    import json
    from artifacts import load_artifact
    path = tmp_path / "unstamped.json"
    path.write_text(json.dumps({
        "modelVersion": "preference-unstamped", "promoted": True, "seed": 1,
        "trainingMethod": "spsa-v1", "lane": "preference", "weights": {"w": [1]},
    }))
    artifact = load_artifact(str(path))
    assert artifact.promoted is False
    assert artifact.rejected_reason == "architecture_mismatch:absent"
