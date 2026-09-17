from config import Settings
from policy import knowledge_decision, preference_decision
from schemas import KnowledgeDecisionInput, PreferenceDecisionInput

settings = Settings(internal_service_token="test")


def test_low_coverage_model_cannot_replace_baseline():
    decision = knowledge_decision(KnowledgeDecisionInput(
        conceptId="fractions",
        baselineMastery=0.4,
        baselineReadiness=0.4,
        gnnMastery=0.95,
        gnnReadiness=0.95,
        gnnEligible=False,
        gnnConfidence=0.9,
    ), settings)
    assert decision["source"] == "baseline"
    assert decision["mastery"] == 0.4


def test_difficulty_can_move_only_one_band():
    decision = knowledge_decision(KnowledgeDecisionInput(
        conceptId="fractions",
        baselineMastery=0.9,
        baselineReadiness=0.95,
        currentDifficulty="simple",
    ), settings)
    assert decision["nextDifficulty"] == "medium"


def test_student_preference_override_beats_model_output():
    decision = preference_decision(PreferenceDecisionInput(
        topicId="space",
        baselineAffinity=0.9,
        gnnAffinity=0.9,
        gnnEligible=True,
        gnnConfidence=0.9,
        hardStance="DISLIKE",
    ), settings)
    assert decision["source"] == "baseline"
    assert decision["overrideApplied"] is True
    assert decision["affinity"] == -1
