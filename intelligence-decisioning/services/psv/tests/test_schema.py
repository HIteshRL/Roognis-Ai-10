import pytest
from pydantic import ValidationError

from schemas import LearningEventInput, TrustedEventInput
from scoring import classify_evidence_kind


def valid_event(**overrides):
    value = {
        "schemaVersion": 1,
        "eventId": "12345678-abcd-4000-8000-123456789012",
        "eventType": "answer_submitted",
        "source": "quiz",
        "clientTsMono": 10,
        "clientTsWall": "2026-08-31T10:00:00Z",
        "conceptId": "fractions.addition",
        "payload": {"correct": True},
    }
    value.update(overrides)
    return value


def test_rejects_preference_events_from_academic_lane():
    with pytest.raises(ValidationError):
        LearningEventInput.model_validate(valid_event(source="discover"))


def test_rejects_raw_written_answer_content():
    with pytest.raises(ValidationError):
        LearningEventInput.model_validate(valid_event(payload={"rawAnswer": "student text"}))


def test_rejects_nested_raw_written_answer_content():
    with pytest.raises(ValidationError):
        LearningEventInput.model_validate(valid_event(payload={"response": {"answerText": "student text"}}))


def test_accepts_curriculum_and_delivery_context_at_envelope_level():
    parsed = LearningEventInput.model_validate(valid_event(
        courseId="course-7", chapterId="chapter-3", contentId="lesson-3.2",
        curriculumVersion="ncert-2026-v4", attemptId="attempt-9", campaignId="campaign-1",
    ))
    assert parsed.chapter_id == "chapter-3"
    assert parsed.curriculum_version == "ncert-2026-v4"
    assert parsed.campaign_id == "campaign-1"


def test_context_fields_are_length_bounded():
    with pytest.raises(ValidationError):
        LearningEventInput.model_validate(valid_event(chapterId="x" * 65))


def test_trusted_outcome_reads_authority_from_envelope_or_payload():
    base = valid_event(
        eventType="written_answer_scored", source="lms", itemId="revision-a",
        payload={"scoreNormalized": 0.4, "grade": None},
    )
    # Envelope-level authoritative fields.
    envelope = TrustedEventInput.model_validate({
        **base, "resultRef": "grade-a", "gradingAuthority": "lms-service",
        "sourceService": "lms-service", "serverOccurredAt": "2026-08-31T10:00:05Z",
    })
    assert envelope.result_ref == "grade-a"
    assert envelope.server_occurred_at is not None
    # Legacy payload-only producers still validate.
    legacy = TrustedEventInput.model_validate({
        **base, "payload": {"scoreNormalized": 0.4, "resultRef": "grade-a", "gradingAuthority": "lms-service"},
    })
    assert legacy.result_ref is None and legacy.payload["resultRef"] == "grade-a"


def test_evidence_kind_is_derived_not_client_declared():
    assert classify_evidence_kind("answer_submitted", trusted=True) == "academic_evidence"
    assert classify_evidence_kind("answer_submitted", trusted=False) == "engagement"
    assert classify_evidence_kind("item_rendered", trusted=False) == "exposure"
    assert classify_evidence_kind("focus_lost", trusted=False, has_campaign=True) == "intervention_outcome"
