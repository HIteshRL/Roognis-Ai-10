from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

RULE_VERSION = "academic-evidence-v2"
THETA_RULE_VERSION = "theta-retention-v1"
TRAITS = ("mastery", "recall_stability", "difficulty_readiness")

# §6.2 provenance. Three version strings answer three different questions and
# must not be collapsed into one:
#   rule_version  — the estimator's arithmetic (how evidence becomes a number).
#                   Bump when compute_baseline / compute_theta_retention change.
#   model_version — which learned artifact, if any, was blended into the result.
#   gate_version  — the policy that decided which of those was ALLOWED to win.
#                   Bump PSV_GATE_RULES_VERSION when evidence_from_event,
#                   effective_evidence or the admission gates change WHAT IS
#                   ADMITTED — not when the arithmetic changes.
PSV_GATE_RULES_VERSION = "psv-admission-v1"

# Matches the decision service contract: decision_client truncates evidence to
# the last 200 and decisions/schemas.py caps the field at max_length=200, so
# anything beyond 200 was never an input to the gate and storing it would claim
# provenance the gate never saw. The complete set is always recoverable from the
# append-only EvidenceRecord ledger; this column is proximate provenance only.
MAX_STATE_EVENT_IDS = 200


def gate_version(decision: dict | None) -> str:
    """Compose PSV's own admission rules with the decision service's rule version.

    A learner-state row must record the policy that admitted its evidence, not
    only the arithmetic that scored it.

    `decisionPath` is carried separately from `ruleVersion` because PSV's local
    fallback reports the estimator's own rule version, so ruleVersion alone
    cannot distinguish "the decision service chose the baseline" from "the
    decision service was never reached". An operator reading a stored row can.
    """
    path = (decision or {}).get("decisionPath") or "unknown-path"
    rule = (decision or {}).get("ruleVersion") or "unversioned"
    return f"{PSV_GATE_RULES_VERSION}+{path}+{rule}"[:120]


def retention_gate_version(retention: dict | None) -> str:
    """Retention has its own gate: theta activation, not the decision service.

    compute_theta_retention's output reaches the table without any decision-layer
    involvement, so borrowing the decision gate version here would misdescribe
    what admitted the row.
    """
    rule = (retention or {}).get("rule_version") or THETA_RULE_VERSION
    return f"{PSV_GATE_RULES_VERSION}+{rule}"[:120]

# §2 of the retention plan: an interaction is one of four kinds, and only
# `academic_evidence` may move mastery / theta. The label is derived here, never
# taken from the client, so a browser cannot promote its own telemetry.
EXPOSURE_EVENT_TYPES = frozenset({"item_rendered", "flashcard_revealed"})
ACADEMIC_OUTCOME_EVENT_TYPES = frozenset(
    {"answer_submitted", "written_answer_scored", "flashcard_review_completed"}
)


def classify_evidence_kind(event_type: str, *, trusted: bool, has_campaign: bool = False) -> str:
    """engagement | exposure | academic_evidence | intervention_outcome."""
    if trusted and event_type in ACADEMIC_OUTCOME_EVENT_TYPES:
        return "academic_evidence"
    if has_campaign:
        return "intervention_outcome"
    if event_type in EXPOSURE_EVENT_TYPES:
        return "exposure"
    return "engagement"


def correlation_key(*, result_ref=None, attempt_id=None, event_id=None) -> str | None:
    """The single trace key for one immediate-path run: prefer the grader's
    result reference, then the attempt, then the raw event id (§8)."""
    for candidate in (result_ref, attempt_id, event_id):
        if candidate:
            return str(candidate)
    return None


@dataclass(frozen=True)
class Evidence:
    event_id: str
    concept_id: str
    outcome: float
    weight: float
    observed_at: datetime
    difficulty: float
    item_id: str | None = None
    supersedes_event_ids: tuple[str, ...] = ()


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def difficulty_value(value: object) -> float:
    return {"simple": 0.25, "medium": 0.55, "hard": 0.85}.get(str(value or "").lower(), 0.5)


def evidence_from_event(event) -> Evidence | None:
    if not event.concept_id:
        return None
    payload = event.payload or {}
    # Legacy/unverified rows are retained for audit but cannot affect mastery.
    if payload.get("_verified") is not True:
        return None
    outcome: float | None = None
    weight = 0.0

    if event.event_type == "answer_submitted":
        if isinstance(payload.get("scoreNormalized"), (int, float)):
            outcome = clamp(payload["scoreNormalized"])
        weight = 1.0
    elif event.event_type == "written_answer_scored":
        if isinstance(payload.get("scoreNormalized"), (int, float)):
            outcome = clamp(payload["scoreNormalized"])
            weight = 1.15
    elif event.event_type == "flashcard_review_completed":
        outcome = {"again": 0.0, "good": 0.7, "easy": 1.0}.get(payload.get("grade"))
        weight = 0.35

    if outcome is None or weight <= 0:
        return None
    return Evidence(
        event_id=event.event_id,
        concept_id=event.concept_id,
        outcome=outcome,
        weight=weight,
        observed_at=event.client_ts_wall,
        difficulty=difficulty_value(payload.get("difficulty")),
        item_id=getattr(event, "item_id", None),
        supersedes_event_ids=tuple(
            value for value in payload.get("supersedesEventIds", [])
            if isinstance(value, str)
        ),
    )


def effective_evidence(evidence: Iterable[Evidence]) -> list[Evidence]:
    # Repeated attempts at the same item on the same day are correlated.
    # Retain the latest result in the estimate; the raw ledger keeps them all.
    rows = sorted(evidence, key=lambda item: (item.observed_at, item.event_id))
    superseded = {
        event_id
        for row in rows
        for event_id in row.supersedes_event_ids
    }
    unique = {}
    for row in rows:
        if row.event_id in superseded:
            continue
        key = (row.item_id, row.observed_at.date()) if row.item_id else row.event_id
        unique[key] = row
    return sorted(unique.values(), key=lambda item: (item.observed_at, item.event_id))


def _bayesian_update(prior: float, outcome: float, weight: float) -> float:
    prior = clamp(prior, 0.01, 0.99)
    likelihood_correct = 0.85
    likelihood_guess = 0.2
    correct_posterior = (prior * likelihood_correct) / (
            prior * likelihood_correct + (1 - prior) * likelihood_guess
        )
    incorrect_posterior = (prior * (1 - likelihood_correct)) / (
            prior * (1 - likelihood_correct) + (1 - prior) * (1 - likelihood_guess)
        )
    posterior = outcome * correct_posterior + (1 - outcome) * incorrect_posterior
    blended = prior + clamp(weight) * (posterior - prior)
    return clamp(blended + 0.08 * weight * (1 - blended))


def compute_baseline(evidence: Iterable[Evidence], *, as_of: datetime | None = None) -> dict:
    rows = effective_evidence(evidence)
    if not rows:
        raise ValueError("compute_baseline requires evidence")

    mastery = 0.25
    recall = 0.25
    readiness = 0.2
    history: list[float] = []
    flashcard_weight = 0.0
    flashcard_score = 0.0

    for row in rows:
        previous = mastery
        mastery = _bayesian_update(mastery, row.outcome, row.weight)
        history.append(mastery - previous)
        readiness = clamp(0.72 * mastery + 0.28 * row.outcome * row.difficulty)
        if row.weight < 0.5:
            flashcard_weight += row.weight
            flashcard_score += row.outcome * row.weight

    if flashcard_weight:
        recall = clamp(flashcard_score / flashcard_weight)
    else:
        recall = clamp(0.7 * mastery + 0.15)

    # Explicitly a heuristic until delayed-recall outcomes support calibration.
    observed = (as_of or datetime.now(timezone.utc)).replace(tzinfo=timezone.utc)
    age_days = max(0, (observed - rows[-1].observed_at.replace(tzinfo=timezone.utc)).total_seconds() / 86400)
    recall *= math.exp(-age_days / (7 + 23 * mastery))

    # Coverage is a conservative heuristic, not calibrated model certainty.
    confidence = clamp(1 - math.exp(-sum(row.weight for row in rows) / 6))
    trend = sum(history[-3:]) / min(3, len(history))
    gap_score = clamp(1 - (0.65 * mastery + 0.2 * recall + 0.15 * readiness))
    return {
        "mastery": mastery,
        "recall_stability": recall,
        "difficulty_readiness": readiness,
        "confidence": confidence,
        "trend": trend,
        "gap_score": gap_score,
        "evidence_count": len(rows),
        "last_evidence_at": rows[-1].observed_at,
        "evidence_ids": [row.event_id for row in rows],
        "rule_version": RULE_VERSION,
        "current_difficulty": "simple" if rows[-1].difficulty < 0.4 else "hard" if rows[-1].difficulty > 0.7 else "medium",
    }


def compute_theta_retention(evidence: Iterable[Evidence], *, as_of: datetime | None = None) -> dict:
    """Estimate an interpretable forgetting rate from delayed retrieval pairs.

    The estimate is deliberately gated. Until two distinct items are observed
    at least 24 hours apart, the result remains a wide seven-day prior and the
    decision layer must continue to use its deterministic fallback.
    """
    rows = effective_evidence(evidence)
    if not rows:
        raise ValueError("compute_theta_retention requires evidence")
    observed = as_of or datetime.now(timezone.utc)
    if observed.tzinfo is None:
        observed = observed.replace(tzinfo=timezone.utc)
    normalized_times = [
        row.observed_at if row.observed_at.tzinfo else row.observed_at.replace(tzinfo=timezone.utc)
        for row in rows
    ]
    distinct_items = len({row.item_id or row.event_id for row in rows})
    pairs = []
    for previous, current, previous_at, current_at in zip(rows, rows[1:], normalized_times, normalized_times[1:]):
        delta_days = max(0.0, (current_at - previous_at).total_seconds() / 86400)
        if delta_days >= 1 and (previous.item_id or previous.event_id) != (current.item_id or current.event_id):
            pairs.append((previous, current, delta_days))

    prior_theta = math.log(2) / 7
    active = distinct_items >= 2 and len(pairs) >= 1
    if active:
        # Bounded grid fit is deterministic, replayable and robust with sparse
        # evidence. A later hierarchical Bayesian trainer can supply the prior
        # without changing the stored contract.
        candidates = [0.001 * (3000 ** (index / 239)) for index in range(240)]
        def loss(theta: float) -> float:
            total = weight = 0.0
            for previous, current, delta in pairs:
                chance = 0.0 if current.weight > 1 else 0.2
                anchor = max(chance, previous.outcome)
                expected = chance + (anchor - chance) * math.exp(-theta * delta)
                pair_weight = min(previous.weight, current.weight)
                total += pair_weight * (current.outcome - expected) ** 2
                weight += pair_weight
            # Weak regularization prevents a single failure selecting the cap.
            return total / max(weight, 1e-9) + 0.02 * (math.log(theta / prior_theta) ** 2)
        theta = min(candidates, key=loss)
        theta_std = max(0.02, theta / math.sqrt(len(pairs)))
        coverage = "active"
    else:
        theta = prior_theta
        theta_std = prior_theta * 1.5
        coverage = "prior"

    anchor = clamp(rows[-1].outcome)
    anchor_at = normalized_times[-1]
    age_days = max(0.0, (observed - anchor_at).total_seconds() / 86400)
    chance = 0.0 if rows[-1].weight > 1 else 0.2
    def predict(days: float) -> float:
        return clamp(chance + (anchor - chance) * math.exp(-theta * days))
    now_recall = predict(age_days)
    target = 0.8
    if anchor <= target or theta <= 0:
        next_days = 0.0
    else:
        numerator = max(1e-9, (target - chance) / max(anchor - chance, 1e-9))
        next_days = max(0.0, -math.log(numerator) / theta)
    from datetime import timedelta
    return {
        "anchor_strength": anchor,
        "anchor_at": anchor_at,
        "theta_mean_per_day": theta,
        "theta_std_dev": theta_std,
        "half_life_days": math.log(2) / theta,
        "predicted_recall_now": now_recall,
        "predicted_recall_24h": predict(age_days + 1),
        "predicted_recall_7d": predict(age_days + 7),
        "next_review_at": anchor_at + timedelta(days=next_days),
        "evidence_count": len(rows),
        "delayed_retrieval_count": len(pairs),
        "distinct_item_count": distinct_items,
        "coverage_status": coverage,
        "last_evidence_at": anchor_at,
        "evidence_ids": [row.event_id for row in rows],
        "rule_version": THETA_RULE_VERSION,
    }
