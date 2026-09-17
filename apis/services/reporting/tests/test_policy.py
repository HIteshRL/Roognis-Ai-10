from datetime import datetime, timedelta, timezone

from policy import build_academic_insights
from schemas import PolicyParameters


NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)


def event(**values):
    result = {
        "conceptId": "fraction-comparison",
        "conceptLabel": "Fraction comparison",
        "mastery": 0.4,
        "gapScore": 0.7,
        "trend": -0.1,
        "confidence": 0.8,
        "evidenceCount": 4,
        "lastEvidenceAt": (NOW - timedelta(days=2)).isoformat(),
        "eventIds": ["must-not-leak"],
        "modelVersion": "must-not-leak",
    }
    result.update(values)
    return result


def test_parent_insight_is_evidence_gated_and_does_not_leak_internal_fields():
    output = build_academic_insights([event()], PolicyParameters(), now=NOW)
    assert output["available"] is True
    row = output["concepts"][0]
    assert row["status"] == "needs_practice"
    assert row["evidence"]["recordCount"] == 4
    assert "eventIds" not in row
    assert "modelVersion" not in row
    assert "mastery" not in row


def test_stale_or_sparse_evidence_becomes_insufficient_not_a_negative_claim():
    output = build_academic_insights([
        event(evidenceCount=1),
        event(conceptId="algebra", lastEvidenceAt=(NOW - timedelta(days=31)).isoformat()),
    ], PolicyParameters(), now=NOW)
    assert output == {"concepts": [], "insufficientEvidenceConceptCount": 2, "available": False}


def test_policy_changes_thresholds_without_code_change():
    output = build_academic_insights(
        [event(gapScore=0.3, mastery=0.8)],
        PolicyParameters(gap_score_threshold=0.2),
        now=NOW,
    )
    assert output["concepts"][0]["status"] == "needs_practice"
