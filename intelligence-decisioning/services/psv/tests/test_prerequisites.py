from decision_client import prerequisite_guard


def test_weak_prerequisite_overrides_next_topic_not_grade_or_mastery():
    decision = {"conceptId": "advanced", "mastery": 0.8, "nextDifficulty": "hard", "evidenceIds": ["a"]}
    result = prerequisite_guard(decision, {"prerequisite_gaps": [
        {"conceptId": "foundation", "mastery": 0.2, "evidenceIds": ["b"]},
        {"conceptId": "other", "mastery": 0.3, "evidenceIds": ["c"]},
    ]})
    assert result["nextConceptId"] == "foundation"
    assert result["mastery"] == 0.8
    assert result["nextDifficulty"] == "medium"
    assert result["scaffold"] == "worked_example"
    assert result["evidenceIds"] == ["a", "b"]
    assert "nextConceptId" not in decision
