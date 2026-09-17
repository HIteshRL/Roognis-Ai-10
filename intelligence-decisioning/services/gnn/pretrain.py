"""Optimize graph weights using SPSA; learner-disjoint validation and test.

SPSA is a bounded CPU loss-gradient estimator. Validation chooses the checkpoint;
the untouched test split is evaluated once. No seed search is used.
"""
from pathlib import Path
import hashlib
import json
import numpy as np
from artifacts import ModelArtifact
from graph_models import KnowledgeGraphTemporalNetwork, PreferenceSignedGNN
from promote import promote_candidate
from schemas import GraphEdge, KnowledgeConcept, KnowledgeEvent, PreferenceEdge, PreferenceNode


def prepare(sample, lane):
    if lane == "preference":
        return _prepare_preference(sample)
    nodes = [KnowledgeConcept.model_validate(x) for x in sample.get("concepts", [])]
    events = [KnowledgeEvent.model_validate(x) for x in sample.get("events", [])]
    identity = sample.get("targetConceptId")
    target = next((x for x in nodes if x.concept_id == identity), None)
    outcome = sample.get("targetOutcome")
    if target is None or isinstance(outcome, bool) or not isinstance(outcome, (float, int)) or not 0 <= outcome <= 1:
        return None
    edges = [GraphEdge.model_validate(x) for x in sample.get("edges", [])]
    return nodes, events, edges, identity, outcome, target.baseline_mastery


def _prepare_preference(sample):
    nodes = [PreferenceNode.model_validate(x) for x in sample.get("nodes", [])]
    identity = sample.get("targetTopicId")
    target = next((n for n in nodes if n.node_id == identity and n.node_type == "topic"), None)
    stance = sample.get("targetStance")
    outcome = float(stance == "LIKE") if stance in {"LIKE", "DISLIKE"} else None
    if target is None or outcome is None:
        return None
    # The held-out edge must be REMOVED from the graph, not merely excluded from
    # the label. With the student as a real node, leaving STUDENT_PREFERS in
    # place lets the model read the answer straight off the edge it is being
    # asked to predict, and the task becomes trivially solvable.
    edges = [
        edge for edge in (PreferenceEdge.model_validate(x) for x in sample.get("edges", []))
        if not (edge.relationship == "STUDENT_PREFERS" and edge.to_id == identity)
    ]
    return nodes, [], edges, identity, outcome, (target.baseline_score + 1) / 2


def predictions(model, rows, lane):
    values = []
    for nodes, events, edges, identity, _, _ in rows:
        scores = model.score(nodes, edges) if lane == "preference" else model.score(nodes, events, edges)
        values.append(next((x["affinity"] + 1) / 2 for x in scores if x["topicId"] == identity) if lane == "preference" else next(x["mastery"] for x in scores if x["conceptId"] == identity))
    return np.asarray(values)


def loss(model, rows, lane):
    return float(np.mean((predictions(model, rows, lane) - np.asarray([x[4] for x in rows])) ** 2)) if rows else 1.0


def calibration(predicted, targets):
    error = 0.0
    for i in range(10):
        selected = (predicted >= i / 10) & (predicted <= 1 if i == 9 else predicted < (i + 1) / 10)
        if selected.any():
            error += float(selected.mean() * abs(predicted[selected].mean() - targets[selected].mean()))
    return error


def split_samples(samples, lane):
    splits, independent, seen = ([], [], []), True, set()
    for sample in samples:
        row = prepare(sample, lane)
        if row is None:
            continue
        fingerprint = hashlib.sha256(json.dumps(sample, sort_keys=True).encode()).hexdigest()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        group = sample.get("splitGroup")
        if not group:
            independent = False
            splits[2].append(row)
            continue
        bucket = int(hashlib.sha256(str(group).encode()).hexdigest()[:8], 16) % 10
        splits[0 if bucket < 6 else 1 if bucket < 8 else 2].append(row)
    return splits, independent


def pretrain_and_promote(*, lane, samples, output: Path, model_version, initial_seed=1729, steps=None):
    if lane not in {"knowledge", "preference"}:
        raise ValueError("Unknown lane")
    (train, validation, test), independent = split_samples(samples, lane)
    artifact = ModelArtifact(model_version, False, initial_seed, {})
    model = PreferenceSignedGNN(artifact) if lane == "preference" else KnowledgeGraphTemporalNetwork(artifact)
    initial = model.export()
    best, best_loss = initial, loss(model, validation, lane)
    rng = np.random.default_rng(initial_seed)
    trained = independent and len(train) >= 20 and len(validation) >= 10 and len(test) >= 20
    if trained:
        # SPSA shares ONE scalar gradient estimate across every parameter, so its
        # variance grows with dimension: a fixed 80 steps that suited a 193-weight
        # model will not move a larger one, and the failure is silent — the
        # candidate simply never clears the promotion gate. Scale with sqrt(p).
        parameter_count = sum(int(v.size) for v in model.parameters().values())
        budget = steps if steps is not None else max(80, min(600, int(20 * parameter_count ** 0.5)))
        for step in range(budget):
            batch = [train[i] for i in rng.choice(len(train), min(16, len(train)), replace=False)]
            parameters = {k: v.copy() for k, v in model.parameters().items()}
            direction = {k: rng.choice([-1.0, 1.0], size=v.shape) for k, v in parameters.items()}
            epsilon = 0.05 / (step + 1) ** 0.101
            model.restore({k: v + epsilon * direction[k] for k, v in parameters.items()})
            positive = loss(model, batch, lane)
            model.restore({k: v - epsilon * direction[k] for k, v in parameters.items()})
            negative = loss(model, batch, lane)
            gradient = np.clip((positive - negative) / (2 * epsilon), -2, 2)
            rate = 0.08 / (step + 1) ** 0.602
            model.restore({k: np.clip(v - rate * gradient * direction[k], -4, 4) for k, v in parameters.items()})
            measured = loss(model, validation, lane)
            if measured < best_loss:
                best, best_loss = model.export(), measured
        model.restore(best)
    predicted = predictions(model, test, lane)
    targets, baseline = np.asarray([x[4] for x in test]), np.asarray([x[5] for x in test])
    candidate_error = float(np.mean((predicted - targets) ** 2)) if test else 1
    baseline_error = float(np.mean((baseline - targets) ** 2)) if test else 1
    metrics = {
        "candidateMetric": 1 - candidate_error, "baselineMetric": 1 - baseline_error,
        "candidateCalibration": calibration(predicted, targets), "baselineCalibration": calibration(baseline, targets),
        "heldOutEvents": len(test), "trainingEvents": len(train), "validationEvents": len(validation),
        "heldOutPositive": int(np.sum(targets >= 0.5)), "heldOutNegative": int(np.sum(targets < 0.5)),
        "independentSplit": independent, "trained": bool(trained), "weightsChanged": model.export() != initial,
        "validationLoss": best_loss, "optimizer": "spsa-v1",
        "parameterCount": sum(int(v.size) for v in model.parameters().values()),
        "trainingSteps": budget if trained else 0,
    }
    diverse_outcomes = metrics["heldOutPositive"] >= 5 and metrics["heldOutNegative"] >= 5
    promoted = trained and diverse_outcomes and metrics["weightsChanged"] and promote_candidate(metrics, output, model_version=model_version, seed=initial_seed, weights=model.export(), lane=lane)
    return {"promoted": bool(promoted), "modelVersion": model_version if promoted else None,
            "reason": None if promoted else "promotion_gate_not_met", "seed": initial_seed, "metrics": metrics}
