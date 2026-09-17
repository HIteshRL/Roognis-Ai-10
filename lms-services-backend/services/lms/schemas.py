"""Request bodies for the LMS service. Responses are plain dicts built by the
serializers in classrooms.py / coursework.py (camelCase, matching the Node
services), so only inbound payloads need Pydantic validation here."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from models import STREAM_PERMISSIONS


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class Attachment(BaseModel):
    """Shared shape for both Coursework and Announcement attachments —
    moved here (Sprint 1, T2.3) since both now use it; stream.py imports it
    back from here rather than defining its own copy."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    type: str = Field(default="link")
    url: str | None = None
    title: str | None = None


class CreateClassroomRequest(_Body):
    name: str = Field(min_length=1, max_length=160)
    subject: str = Field(min_length=1, max_length=120)
    section: str | None = Field(default=None, max_length=80)
    room: str | None = Field(default=None, max_length=80)
    grade: str | None = Field(default=None, max_length=40)
    description: str | None = None
    color: str | None = Field(default=None, max_length=16)
    term_id: str | None = Field(default=None, alias="termId", max_length=36)
    require_approval: bool = Field(default=False, alias="requireApproval")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class ClassroomSettingsUpdate(_Body):
    require_approval: bool | None = Field(default=None, alias="requireApproval")
    stream_permission: str | None = Field(default=None, alias="streamPermission")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)

    @field_validator("stream_permission")
    @classmethod
    def _validate_stream_permission(cls, value: str | None) -> str | None:
        if value is not None and value not in STREAM_PERMISSIONS:
            raise ValueError(f"streamPermission must be one of {STREAM_PERMISSIONS}")
        return value


class UpdateClassroomRequest(_Body):
    name: str | None = Field(default=None, max_length=160)
    subject: str | None = Field(default=None, max_length=120)
    section: str | None = Field(default=None, max_length=80)
    room: str | None = Field(default=None, max_length=80)
    grade: str | None = Field(default=None, max_length=40)
    description: str | None = None
    color: str | None = Field(default=None, max_length=16)
    term_id: str | None = Field(default=None, alias="termId", max_length=36)
    settings: ClassroomSettingsUpdate | None = None

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class JoinCodeSettingRequest(_Body):
    enabled: bool


class JoinRequest(_Body):
    code: str = Field(min_length=4, max_length=16, alias="joinCode")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class CreateChapterRequest(_Body):
    title: str = Field(min_length=1, max_length=220)
    description: str | None = None
    order_index: int | None = Field(default=None, alias="orderIndex", ge=0)
    knowledge_base_id: str | None = Field(default=None, alias="knowledgeBaseId", max_length=36)

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class UpdateChapterRequest(_Body):
    title: str | None = Field(default=None, max_length=220)
    description: str | None = None
    order_index: int | None = Field(default=None, alias="orderIndex", ge=0)
    is_published: bool | None = Field(default=None, alias="isPublished")
    knowledge_base_id: str | None = Field(default=None, alias="knowledgeBaseId", max_length=36)

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class PublishCourseworkRequest(_Body):
    """Sprint 3, T2.1/T2.4: optional targeting on publish. Omitting the body
    entirely (the pre-Sprint-3 behaviour) keeps a coursework item class-wide
    — `target_mode` defaults to 'all', and `studentIds`/`groupIds` are
    ignored in that case rather than erroring, so an old client that never
    learns about targeting keeps working unchanged."""

    target_mode: str = Field(default="all", alias="targetMode")
    student_ids: list[str] = Field(default_factory=list, alias="studentIds")
    group_ids: list[str] = Field(default_factory=list, alias="groupIds")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class QuizScoreRequest(_Body):
    """Sprint 3, T3.3: the internal-token-gated payload the Quiz Service
    posts after grading a student's attempt (`services/quiz/lib/
    scoring.js`). `attempt_id` is accepted but not stored anywhere on the
    LMS side yet — carried for future audit-trail linkage, not read by
    record_quiz_score today."""

    quiz_id: str = Field(min_length=1, max_length=36, alias="quizId")
    student_id: str = Field(min_length=1, max_length=36, alias="studentId")
    score: float = Field(ge=0)
    max_score: float = Field(gt=0, alias="maxScore")
    attempt_id: str | None = Field(default=None, max_length=64, alias="attemptId")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class LinkQuizRequest(_Body):
    quiz_id: str = Field(min_length=1, max_length=36, alias="quizId")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class CreateCourseworkRequest(_Body):
    title: str = Field(min_length=1, max_length=240)
    type: str = Field(default="assignment")
    description: str | None = None
    topic: str | None = Field(default=None, max_length=160)
    chapter_id: str | None = Field(default=None, alias="chapterId", max_length=36)
    max_points: float | None = Field(default=None, alias="maxPoints", ge=0)
    due_at: datetime | None = Field(default=None, alias="dueAt")
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    attachments: list[Attachment] = Field(default_factory=list)
    # Frozen contract C1 (Sprint 1, T2.2): the column and its enforcement in
    # submit_coursework/save_draft shipped in Sprint 1, but this field was
    # never added to either request model — no caller could ever set it to
    # anything but the column default (True), so every assignment permanently
    # allowed resubmission regardless of what a teacher intended. `None`
    # means "use the default", not "explicitly true" — see create_coursework.
    allow_resubmission: bool | None = Field(default=None, alias="allowResubmission")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class DuplicateCourseworkRequest(_Body):
    """Sprint 4, P2 (T2.1): both fields optional — omitting `classroomId`
    duplicates in place (same classroom); supplying a different one is the
    cross-section reuse case. Omitting `title` defaults to "<original> (copy)"
    server-side (`coursework.py::duplicate_coursework`)."""

    classroom_id: str | None = Field(default=None, alias="classroomId", max_length=36)
    title: str | None = Field(default=None, max_length=240)

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class UpdateCourseworkRequest(_Body):
    title: str | None = Field(default=None, max_length=240)
    description: str | None = None
    topic: str | None = Field(default=None, max_length=160)
    chapter_id: str | None = Field(default=None, alias="chapterId", max_length=36)
    max_points: float | None = Field(default=None, alias="maxPoints", ge=0)
    due_at: datetime | None = Field(default=None, alias="dueAt")
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    attachments: list[Attachment] | None = None
    allow_resubmission: bool | None = Field(default=None, alias="allowResubmission")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class SubmitRequest(_Body):
    content: dict | None = None
    text: str | None = None


class RubricScoreItem(_Body):
    criterion: str = Field(min_length=1, max_length=200)
    points: float = Field(ge=0)


class GradeRequest(_Body):
    # Sprint 1, T3.4: grade becomes optional once rubricScores can compute
    # it — "the rubric computes [the grade], it does not replace it," so
    # exactly one of the two must be given (see the validator below).
    grade: float | None = Field(default=None, ge=0)
    feedback: str | None = None
    return_to_student: bool = Field(default=True, alias="returnToStudent")
    rubric_scores: list[RubricScoreItem] | None = Field(default=None, alias="rubricScores")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)

    @model_validator(mode="after")
    def _require_grade_or_rubric(self) -> "GradeRequest":
        if self.grade is None and not self.rubric_scores:
            raise ValueError("Provide either grade or rubricScores.")
        return self


class BulkGradeItem(_Body):
    submission_id: str = Field(alias="submissionId")
    grade: float = Field(ge=0)
    feedback: str | None = None

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)


class BulkGradeRequest(_Body):
    # Sprint 4, P3 (frozen contract C12 — bulk writes are bounded): 200
    # matches the `Query(ge=1, le=200)` cap the pagination routes already
    # use, so a client can never assemble a batch larger than one page of
    # submissions it just read.
    grades: list[BulkGradeItem] = Field(min_length=1, max_length=200)
    return_to_student: bool = Field(default=True, alias="returnToStudent")

    model_config = ConfigDict(populate_by_name=True, extra="ignore", str_strip_whitespace=True)
