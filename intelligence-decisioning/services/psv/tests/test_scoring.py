from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from scoring import compute_baseline, compute_theta_retention, effective_evidence, evidence_from_event


def event(event_type: str, payload: dict, *, concept_id: str = "fractions.addition"):
    return SimpleNamespace(
        event_id=f"event-{event_type}-{payload}",
        event_type=event_type,
        concept_id=concept_id,
        payload={"_verified": True, **({"scoreNormalized": float(payload["correct"])} if "correct" in payload else {}), **payload},
        client_ts_wall=datetime.now(timezone.utc),
        item_id=payload.get("itemId"),
    )


def test_assessed_answers_have_more_weight_than_flashcard_self_reports():
    answer = evidence_from_event(event("answer_submitted", {"correct": False, "difficulty": "medium"}))
    card = evidence_from_event(event("flashcard_review_completed", {"grade": "again"}))
    assert answer.weight > card.weight


def test_baseline_exposes_versioned_academic_traits():
    rows = [
        evidence_from_event(event("answer_submitted", {"correct": False, "difficulty": "medium"})),
        evidence_from_event(event("answer_submitted", {"correct": True, "difficulty": "hard"})),
    ]
    result = compute_baseline(rows)
    assert 0 <= result["mastery"] <= 1
    assert 0 <= result["gap_score"] <= 1
    assert result["rule_version"] == "academic-evidence-v2"


def test_unverified_legacy_scores_do_not_affect_mastery():
    forged = event("written_answer_scored", {"scoreNormalized": 1, "_verified": False})
    assert evidence_from_event(forged) is None


def test_partial_credit_is_not_treated_as_a_perfect_answer():
    from scoring import _bayesian_update
    assert _bayesian_update(0.25, 0.5, 1) < _bayesian_update(0.25, 1, 1)
    assert _bayesian_update(0.25, 0, 1) < _bayesian_update(0.25, 0.5, 1)


def test_theta_stays_on_prior_until_distinct_delayed_retrieval():
    first = event("written_answer_scored", {"scoreNormalized": 1, "itemId": "item-a"})
    result = compute_theta_retention([evidence_from_event(first)])
    assert result["coverage_status"] == "prior"
    assert result["delayed_retrieval_count"] == 0


def test_theta_activates_only_after_distinct_item_at_least_one_day_later():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    first = event("written_answer_scored", {"scoreNormalized": 1, "itemId": "item-a"})
    second = event("written_answer_scored", {"scoreNormalized": 0.6, "itemId": "item-b"})
    first.client_ts_wall = start
    second.client_ts_wall = start + timedelta(hours=25)
    result = compute_theta_retention(
        [evidence_from_event(first), evidence_from_event(second)],
        as_of=second.client_ts_wall,
    )
    assert result["coverage_status"] == "active"
    assert result["delayed_retrieval_count"] == 1
    assert result["distinct_item_count"] == 2
    assert result["predicted_recall_7d"] <= result["predicted_recall_24h"]


def test_corrected_evidence_supersedes_the_old_score_without_deleting_it():
    old = event("written_answer_scored", {"scoreNormalized": 1, "itemId": "revision-a"})
    old.event_id = "old-event"
    corrected = event("written_answer_scored", {
        "scoreNormalized": 0.4,
        "itemId": "revision-a",
        "supersedesEventIds": ["old-event"],
    })
    corrected.event_id = "corrected-event"
    corrected.client_ts_wall = old.client_ts_wall + timedelta(days=2)
    rows = effective_evidence([evidence_from_event(old), evidence_from_event(corrected)])
    assert [row.event_id for row in rows] == ["corrected-event"]
    assert compute_baseline(rows)["evidence_count"] == 1
