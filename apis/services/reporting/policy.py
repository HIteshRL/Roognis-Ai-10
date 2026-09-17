from datetime import datetime, timedelta, timezone
from typing import Any

from schemas import PolicyParameters

POLICY_KEY = "parent-report"
REPORT_CONTRACT_VERSION = "parent-report-v1"


def default_parameters() -> PolicyParameters:
    return PolicyParameters()


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def build_academic_insights(
    knowledge_gaps: list[dict[str, Any]],
    parameters: PolicyParameters,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Turn eligible PSV facts into parent-readable, non-diagnostic insights.

    This function receives a service-to-service payload. It intentionally drops
    provenance event IDs, model versions, decision sources and raw scores from
    the parent contract. The report keeps coverage and freshness so an insight
    is explainable without exposing the learner's internal record.
    """

    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=parameters.stale_after_days)
    eligible: list[dict[str, Any]] = []
    insufficient = 0

    for row in knowledge_gaps:
        evidence_count = row.get("evidenceCount")
        confidence = row.get("confidence")
        last_evidence_at = _parse_timestamp(row.get("lastEvidenceAt"))
        if (
            not isinstance(evidence_count, int)
            or evidence_count < parameters.minimum_evidence_count
            or not isinstance(confidence, (int, float))
            or confidence < parameters.minimum_confidence
            or not last_evidence_at
            or last_evidence_at < cutoff
        ):
            insufficient += 1
            continue

        mastery = float(row.get("mastery") or 0)
        gap_score = float(row.get("gapScore") or 0)
        trend = float(row.get("trend") or 0)
        if gap_score >= parameters.gap_score_threshold:
            status = "needs_practice"
        elif mastery >= parameters.strength_mastery_threshold:
            status = "strength"
        else:
            status = "developing"

        label = row.get("conceptLabel") if isinstance(row.get("conceptLabel"), str) else "Assessed concept"
        eligible.append({
            "conceptId": row.get("conceptId"),
            "conceptLabel": label,
            "status": status,
            "trend": "improving" if trend > 0.05 else "declining" if trend < -0.05 else "steady",
            "evidence": {
                "recordCount": evidence_count,
                "lastObservedAt": last_evidence_at.isoformat(),
                "coverage": "sufficient",
            },
            "suggestedAction": _suggested_action(status, label),
            "sortScore": gap_score if status == "needs_practice" else -mastery,
        })

    eligible.sort(key=lambda row: (0 if row["status"] == "needs_practice" else 1, row["sortScore"]))
    concepts = [{key: value for key, value in row.items() if key != "sortScore"} for row in eligible[:parameters.maximum_concepts]]
    return {
        "concepts": concepts,
        "insufficientEvidenceConceptCount": insufficient,
        "available": bool(concepts),
    }


def _suggested_action(status: str, label: str) -> str:
    if status == "needs_practice":
        return f"Try a short, supported practice session on {label}, then review a fresh question."
    if status == "strength":
        return f"Ask the student to explain one {label} solution in their own words to reinforce the progress."
    return f"Continue regular practice on {label} and review the next independent result."
