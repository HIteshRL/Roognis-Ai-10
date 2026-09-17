from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import math


ACADEMIC_EVENT_TYPES = frozenset({
    "item_rendered",
    "first_interaction",
    "answer_changed",
    "answer_submitted",
    "item_skipped",
    "hint_requested",
    "confidence_reported",
    "focus_lost",
    "focus_gained",
    "written_answer_scored",
    "flashcard_revealed",
    "flashcard_review_completed",
})
ACADEMIC_SOURCES = frozenset({"quiz", "written_answer", "flashcard", "practice", "lms"})
FORBIDDEN_RAW_TEXT_KEYS = frozenset({"answer", "answertext", "rawanswer", "prompt", "content", "text"})


class LearningEventInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    schema_version: Literal[1] = Field(alias="schemaVersion")
    event_id: str = Field(alias="eventId", min_length=8, max_length=64)
    event_type: str = Field(alias="eventType", max_length=48)
    source: str = Field(max_length=32)
    session_id: str | None = Field(default=None, alias="sessionId", max_length=128)
    item_id: str | None = Field(default=None, alias="itemId", max_length=160)
    concept_id: str | None = Field(default=None, alias="conceptId", max_length=160)
    # Curriculum / delivery context. Not evidence; a browser may legitimately
    # declare what it was showing and which campaign prompted the activity.
    course_id: str | None = Field(default=None, alias="courseId", max_length=64)
    chapter_id: str | None = Field(default=None, alias="chapterId", max_length=64)
    content_id: str | None = Field(default=None, alias="contentId", max_length=160)
    curriculum_version: str | None = Field(default=None, alias="curriculumVersion", max_length=64)
    attempt_id: str | None = Field(default=None, alias="attemptId", max_length=64)
    campaign_id: str | None = Field(default=None, alias="campaignId", max_length=64)
    client_ts_mono: float = Field(alias="clientTsMono", ge=0, allow_inf_nan=False)
    client_ts_wall: datetime = Field(alias="clientTsWall")
    payload: dict[str, Any] = Field(default_factory=dict)
    student_id: str | None = Field(default=None, alias="studentId", max_length=36)
    school_id: str | None = Field(default=None, alias="schoolId", max_length=36)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, value: str) -> str:
        if value not in ACADEMIC_EVENT_TYPES:
            raise ValueError("eventType is not an academic measurement event")
        return value

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if value not in ACADEMIC_SOURCES:
            raise ValueError("source is not an academic measurement source")
        return value

    @field_validator("payload")
    @classmethod
    def reject_raw_student_text(cls, value: dict[str, Any]) -> dict[str, Any]:
        forbidden: set[str] = set()

        def scan(candidate: Any) -> None:
            if isinstance(candidate, dict):
                for key, nested in candidate.items():
                    normalized = str(key).lower().replace("_", "").replace("-", "").replace(" ", "")
                    if normalized in FORBIDDEN_RAW_TEXT_KEYS:
                        forbidden.add(str(key))
                    scan(nested)
            elif isinstance(candidate, list):
                for nested in candidate:
                    scan(nested)

        scan(value)
        if forbidden:
            raise ValueError(f"raw student text is not accepted in the PSV event stream: {sorted(forbidden)}")
        return value


class BrowserEventInput(LearningEventInput):
    event_id: str = Field(alias="eventId", pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    @model_validator(mode="after")
    def browser_is_not_a_grader(self):
        if self.event_type in {"written_answer_scored", "flashcard_review_completed"}:
            raise ValueError("Outcome events must come from the assessment service")
        allowed = {"answerPresent", "difficulty", "questionType", "latencyMs", "confidence",
                   "hintId", "changeCount", "visibleMs", "reason", "activity"}
        if set(self.payload) - allowed:
            raise ValueError("Browser payload contains untrusted evidence fields")
        for key, value in self.payload.items():
            if key == "answerPresent":
                valid = isinstance(value, bool)
            elif key in {"latencyMs", "visibleMs", "changeCount", "confidence"}:
                maximum = 1 if key == "confidence" else 604800000
                valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= maximum
            else:
                valid = isinstance(value, str) and len(value) <= 160
            if not valid:
                raise ValueError(f"Invalid browser interaction field: {key}")
        return self


class TrustedEventInput(LearningEventInput):
    # Authoritative-only envelope fields. Producers should set these directly;
    # the payload fallbacks keep pre-contract producers working during rollout.
    server_occurred_at: datetime | None = Field(default=None, alias="serverOccurredAt")
    grading_authority: str | None = Field(default=None, alias="gradingAuthority", max_length=48)
    result_ref: str | None = Field(default=None, alias="resultRef", max_length=200)
    source_service: str | None = Field(default=None, alias="sourceService", max_length=48)

    @model_validator(mode="after")
    def validate_outcome(self):
        p = self.payload
        result_ref = self.result_ref or p.get("resultRef")
        grading_authority = self.grading_authority or p.get("gradingAuthority")
        if not self.concept_id or not self.item_id or not result_ref:
            raise ValueError("Trusted outcomes require concept, item and result reference")
        if self.event_type == "flashcard_review_completed":
            if self.source != "flashcard" or p.get("grade") not in {"again", "good", "easy"}:
                raise ValueError("Invalid flashcard outcome")
        elif self.event_type in {"answer_submitted", "written_answer_scored"}:
            authority = {"quiz": "quiz-service", "written_answer": "quiz-service", "practice": "practice-service", "lms": "lms-service"}
            if grading_authority != authority.get(self.source) or self.source not in authority:
                raise ValueError("Invalid grading authority")
            score = p.get("scoreNormalized")
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid normalized score")
        else:
            raise ValueError("Internal endpoint only accepts authoritative outcomes")
        return self


class EventBatchInput(BaseModel):
    events: list[BrowserEventInput] = Field(min_length=1, max_length=100)


class InternalEventBatchInput(BaseModel):
    events: list[TrustedEventInput] = Field(min_length=1, max_length=500)


class AggregateRequest(BaseModel):
    student_ids: list[str] = Field(alias="studentIds", min_length=1, max_length=500)
    school_id: str = Field(alias="schoolId", min_length=8, max_length=36)

    model_config = ConfigDict(populate_by_name=True)
