from config import Settings
from schemas import KnowledgeDecisionInput, PreferenceDecisionInput


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def preference_decision(item: PreferenceDecisionInput, settings: Settings) -> dict:
    override_applied = item.hard_stance is not None
    if item.hard_stance == "MUTE":
        value = -1.0
        source = "baseline"
    elif item.hard_stance == "LIKE":
        value = 1.0
        source = "baseline"
    elif item.hard_stance == "DISLIKE":
        value = -1.0
        source = "baseline"
    elif item.gnn_eligible and item.gnn_affinity is not None and item.gnn_confidence >= settings.gnn_min_confidence:
        weight = min(settings.gnn_max_blend_weight, item.gnn_confidence)
        value = (1 - weight) * item.baseline_affinity + weight * item.gnn_affinity
        source = "gnn"
    else:
        value = item.baseline_affinity
        source = "baseline"
    return {
        "topicId": item.topic_id,
        "affinity": max(-1.0, min(1.0, value)),
        "source": source,
        "overrideApplied": override_applied,
        "ruleVersion": settings.decision_rule_version,
        "modelVersion": item.model_version if source == "gnn" else None,
        "evidenceIds": item.evidence_ids,
    }


def _bounded_difficulty(readiness: float, current: str) -> str:
    target = "simple" if readiness < 0.4 else ("medium" if readiness < 0.72 else "hard")
    levels = ["simple", "medium", "hard"]
    current_index = levels.index(current)
    target_index = levels.index(target)
    bounded_index = max(current_index - 1, min(current_index + 1, target_index))
    return levels[bounded_index]


def knowledge_decision(item: KnowledgeDecisionInput, settings: Settings) -> dict:
    source = "baseline"
    mastery = item.baseline_mastery
    readiness = item.baseline_readiness
    if (
        item.gnn_eligible
        and item.gnn_mastery is not None
        and item.gnn_readiness is not None
        and item.gnn_confidence >= settings.gnn_min_confidence
    ):
        weight = min(settings.gnn_max_blend_weight, item.gnn_confidence)
        mastery = (1 - weight) * mastery + weight * item.gnn_mastery
        readiness = (1 - weight) * readiness + weight * item.gnn_readiness
        source = "gnn"

    scaffold = "worked_example" if mastery < 0.3 else ("completion_problem" if mastery < 0.7 else "bare_problem")
    return {
        "conceptId": item.concept_id,
        "mastery": clamp(mastery),
        "difficultyReadiness": clamp(readiness),
        "nextDifficulty": _bounded_difficulty(readiness, item.current_difficulty),
        "scaffold": scaffold,
        "source": source,
        "overrideApplied": False,
        "ruleVersion": settings.decision_rule_version,
        "modelVersion": item.model_version if source == "gnn" else None,
        "evidenceIds": item.evidence_ids,
    }
