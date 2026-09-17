import math
import os
from threading import Lock
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException

from artifacts import load_artifact, BOOTSTRAP_ARTIFACT
from auth import require_internal_token
from config import Settings, get_settings
from graph_models import KnowledgeGraphTemporalNetwork, PreferenceSignedGNN
from schemas import KnowledgeScoreRequest, PreferenceScoreRequest

settings = get_settings()

def validated_models(path):
    candidate = load_artifact(path)
    if candidate.promoted and candidate.lane != settings.gnn_lane:
        raise ValueError("Artifact belongs to another graph lane")
    return candidate, PreferenceSignedGNN(candidate), KnowledgeGraphTemporalNetwork(candidate)

try:
    artifact, preference_model, knowledge_model = validated_models(settings.gnn_model_artifact)
except (ValueError, KeyError, TypeError, OSError):
    artifact = BOOTSTRAP_ARTIFACT
    preference_model, knowledge_model = PreferenceSignedGNN(artifact), KnowledgeGraphTemporalNetwork(artifact)
artifact_mtime_ns = os.stat(settings.gnn_model_artifact).st_mtime_ns if settings.gnn_model_artifact and os.path.isfile(settings.gnn_model_artifact) else None
artifact_lock = Lock()

app = FastAPI(title="Roognis GNN Inference Service")


def current_models():
    """Reload an atomically promoted artifact without restarting inference."""
    global artifact, preference_model, knowledge_model, artifact_mtime_ns
    path = settings.gnn_model_artifact
    observed_mtime = os.stat(path).st_mtime_ns if path and os.path.isfile(path) else None
    if observed_mtime == artifact_mtime_ns:
        return artifact, preference_model, knowledge_model
    with artifact_lock:
        observed_mtime = os.stat(path).st_mtime_ns if path and os.path.isfile(path) else None
        if observed_mtime != artifact_mtime_ns:
            try:
                candidate, preference, knowledge = validated_models(path)
            except (ValueError, KeyError, TypeError, OSError):
                # A malformed candidate must not replace the last usable model.
                artifact_mtime_ns = observed_mtime
                return artifact, preference_model, knowledge_model
            artifact, preference_model, knowledge_model = candidate, preference, knowledge
            artifact_mtime_ns = observed_mtime
    return artifact, preference_model, knowledge_model


@app.get("/health")
@app.get("/internal/gnn/health")
def health():
    active_artifact, _, _ = current_models()
    return {
        "status": "ok",
        "service": "gnn",
        "lane": settings.gnn_lane,
        "modelVersion": active_artifact.model_version,
        "promoted": active_artifact.promoted,
        # Without these an operator cannot tell a REJECTED artifact from an
        # absent one: both simply serve baseline scores.
        "architecture": active_artifact.architecture,
        "rejectedReason": active_artifact.rejected_reason,
        "promotedAt": active_artifact.promoted_at.isoformat() if active_artifact.promoted_at else None,
        "modelAgeHours": (
            round((datetime.now(timezone.utc) - active_artifact.promoted_at).total_seconds() / 3600, 2)
            if active_artifact.promoted_at else None
        ),
        "stale": artifact_is_stale(active_artifact),
    }


def artifact_is_stale(active_artifact, now: datetime | None = None) -> bool:
    if not active_artifact.promoted:
        return False
    if active_artifact.promoted_at is None:
        return True
    observed = now or datetime.now(timezone.utc)
    return (observed - active_artifact.promoted_at).total_seconds() > settings.gnn_max_model_age_hours * 3600


def eligibility(active_artifact, coverage: int, minimum: int, confidence: float) -> tuple[bool, str | None]:
    if settings.gnn_shadow_mode:
        return False, "shadow_mode"
    if not active_artifact.promoted:
        return False, "unpromoted_model"
    if artifact_is_stale(active_artifact):
        return False, "stale_model"
    if coverage < minimum:
        return False, "insufficient_coverage"
    if confidence < settings.gnn_min_confidence:
        return False, "low_confidence"
    return True, None


@app.post("/internal/gnn/v1/preference/score")
def score_preferences(body: PreferenceScoreRequest, _: None = Depends(require_internal_token)):
    if settings.gnn_lane != "preference":
        raise HTTPException(status_code=409, detail="This GNN deployment is not configured for preference inference.")
    active_artifact, active_model, _ = current_models()
    scores = active_model.score(body.nodes, body.edges)
    # Coverage is the student's own signed edges — the evidence that actually
    # personalises a score. Content-to-topic edges are shared across students
    # and must not make a brand-new learner look well-covered.
    coverage = sum(
        1 for edge in body.edges
        if edge.relationship in {"STUDENT_PREFERS", "STUDENT_ENGAGED"}
    )
    confidence = min(0.99, 1 - math.exp(-coverage / 6))
    eligible, reason = eligibility(active_artifact, coverage, settings.gnn_min_preference_coverage, confidence)
    return {
        "eligible": eligible,
        "reason": reason,
        "coverage": coverage,
        "confidence": confidence,
        "confidenceKind": "coverage_heuristic",
        "uncertainty": 1 - confidence,
        "modelVersion": active_artifact.model_version,
        "scores": scores,
    }


@app.post("/internal/gnn/v1/knowledge/score")
def score_knowledge(body: KnowledgeScoreRequest, _: None = Depends(require_internal_token)):
    if settings.gnn_lane != "knowledge":
        raise HTTPException(status_code=409, detail="This GNN deployment is not configured for knowledge inference.")
    active_artifact, _, active_model = current_models()
    scores = active_model.score(body.concepts, body.events, body.edges)
    coverage = len(body.events)
    confidence = min(0.99, 1 - math.exp(-coverage / 8))
    eligible, reason = eligibility(active_artifact, coverage, settings.gnn_min_knowledge_coverage, confidence)
    return {
        "eligible": eligible,
        "reason": reason,
        "coverage": coverage,
        "confidence": confidence,
        "confidenceKind": "coverage_heuristic",
        "uncertainty": 1 - confidence,
        "modelVersion": active_artifact.model_version,
        "scores": scores,
    }
