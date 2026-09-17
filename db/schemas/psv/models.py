from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, Index, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class LearningEvent(Base):
    __tablename__ = "learning_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    event_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    session_id: Mapped[str | None] = mapped_column(String(128))
    item_id: Mapped[str | None] = mapped_column(String(160))
    concept_id: Mapped[str | None] = mapped_column(String(160), index=True)
    # Curriculum / delivery context (§7 envelope fields).
    course_id: Mapped[str | None] = mapped_column(String(64))
    chapter_id: Mapped[str | None] = mapped_column(String(64), index=True)
    content_id: Mapped[str | None] = mapped_column(String(160))
    curriculum_version: Mapped[str | None] = mapped_column(String(64))
    attempt_id: Mapped[str | None] = mapped_column(String(64))
    campaign_id: Mapped[str | None] = mapped_column(String(64), index=True)
    # Authoritative-only provenance; null for browser telemetry.
    server_occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    grading_authority: Mapped[str | None] = mapped_column(String(48))
    result_ref: Mapped[str | None] = mapped_column(String(200))
    source_service: Mapped[str | None] = mapped_column(String(48))
    # Server-derived: engagement | exposure | academic_evidence | intervention_outcome.
    evidence_kind: Mapped[str | None] = mapped_column(String(24), index=True)
    client_ts_mono: Mapped[float] = mapped_column(Float, nullable=False)
    client_ts_wall: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_learning_events_student_concept_time", "student_id", "concept_id", "client_ts_wall"),
    )


class EvidenceRecord(Base):
    __tablename__ = "evidence_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    event_id: Mapped[str] = mapped_column(String(64), nullable=False)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    trait_type: Mapped[str] = mapped_column(String(40), nullable=False)
    outcome: Mapped[float] = mapped_column(Float, nullable=False)
    evidence_weight: Mapped[float] = mapped_column(Float, nullable=False)
    rule_version: Mapped[str] = mapped_column(String(40), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("event_id", "trait_type", name="uq_evidence_event_trait"),
        Index("ix_evidence_student_concept_trait", "student_id", "concept_id", "trait_type"),
    )


class TraitState(Base):
    __tablename__ = "trait_states"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False)
    trait_type: Mapped[str] = mapped_column(String(40), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False)
    trend: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rule_version: Mapped[str] = mapped_column(String(40), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    # §6.2: no learner-state write without the events it came from and the gate
    # version that admitted them. Proximate provenance, bounded to the decision
    # contract's 200; the complete set lives in the EvidenceRecord ledger, which
    # is what reverse lookup ("every state derived from event X") should query.
    # JSON rather than postgresql.ARRAY: ARRAY has no SQLite compilation and
    # would break Base.metadata.create_all in the test fixtures.
    event_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    gate_version: Mapped[str] = mapped_column(String(120), nullable=False)
    # Distinguishes "GNN was ineligible" from "decision service was unreachable";
    # model_version is None in both cases, so without this they are identical.
    decision_source: Mapped[str] = mapped_column(String(24), nullable=False, default="baseline")
    last_evidence_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("student_id", "concept_id", "trait_type", name="uq_trait_thread"),
        Index("ix_trait_student_concept", "student_id", "concept_id"),
    )


class KnowledgeGapSnapshot(Base):
    __tablename__ = "knowledge_gap_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False)
    concept_label: Mapped[str] = mapped_column(String(240), nullable=False, default="Assessed concept")
    trend: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    mastery: Mapped[float] = mapped_column(Float, nullable=False)
    recall_stability: Mapped[float] = mapped_column(Float, nullable=False)
    difficulty_readiness: Mapped[float] = mapped_column(Float, nullable=False)
    next_difficulty: Mapped[str] = mapped_column(String(20), nullable=False, default="medium")
    next_concept_id: Mapped[str | None] = mapped_column(String(160))
    scaffold: Mapped[str] = mapped_column(String(40), nullable=False, default="completion_problem")
    gap_score: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    uncertainty: Mapped[float] = mapped_column(Float, nullable=False)
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False)
    decision_source: Mapped[str] = mapped_column(String(20), nullable=False)
    rule_version: Mapped[str] = mapped_column(String(40), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    # §6.2 provenance — see TraitState.event_ids for why JSON and why bounded.
    event_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    gate_version: Mapped[str] = mapped_column(String(120), nullable=False)
    # End-to-end trace key: the triggering authoritative result (resultRef /
    # attemptId / eventId). Lets one query walk event → snapshot → decision →
    # campaign → delivery (§8).
    correlation_id: Mapped[str | None] = mapped_column(String(200), index=True)
    last_evidence_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("student_id", "concept_id", name="uq_gap_student_concept"),
        Index("ix_gap_school_concept", "school_id", "concept_id"),
    )


class RefreshRun(Base):
    __tablename__ = "refresh_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    run_key: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    lane: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")
    processed_students: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    training_status: Mapped[str] = mapped_column(String(24), nullable=False, default="not_started")
    training_promoted: Mapped[bool] = mapped_column(default=False, nullable=False)
    training_reason: Mapped[str | None] = mapped_column(String(80))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(1000))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DecisionRecord(Base):
    __tablename__ = "decision_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    decision_type: Mapped[str] = mapped_column(String(40), nullable=False)
    decision: Mapped[dict] = mapped_column(JSON, nullable=False)
    source: Mapped[str] = mapped_column(String(24), nullable=False)
    rule_version: Mapped[str] = mapped_column(String(80), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    # Named evidence_ids rather than event_ids for historical reasons; it holds
    # the same thing the state tables call event_ids. Kept as-is to avoid a
    # rename migration on an append-only table with existing rows.
    evidence_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    gate_version: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_decision_student_concept_time", "student_id", "concept_id", "created_at"),
    )


class RetentionState(Base):
    __tablename__ = "retention_states"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False)
    anchor_strength: Mapped[float] = mapped_column(Float, nullable=False)
    anchor_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    theta_mean_per_day: Mapped[float] = mapped_column(Float, nullable=False)
    theta_std_dev: Mapped[float] = mapped_column(Float, nullable=False)
    half_life_days: Mapped[float] = mapped_column(Float, nullable=False)
    predicted_recall_now: Mapped[float] = mapped_column(Float, nullable=False)
    predicted_recall_24h: Mapped[float] = mapped_column(Float, nullable=False)
    predicted_recall_7d: Mapped[float] = mapped_column(Float, nullable=False)
    next_review_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False)
    delayed_retrieval_count: Mapped[int] = mapped_column(Integer, nullable=False)
    distinct_item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    coverage_status: Mapped[str] = mapped_column(String(20), nullable=False)
    rule_version: Mapped[str] = mapped_column(String(80), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    # §6.2 provenance. Retention's gate is theta activation, not the decision
    # service, so gate_version here is composed from THETA_RULE_VERSION.
    event_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    gate_version: Mapped[str] = mapped_column(String(120), nullable=False)
    decision_source: Mapped[str] = mapped_column(String(24), nullable=False, default="baseline")
    correlation_id: Mapped[str | None] = mapped_column(String(200), index=True)
    last_evidence_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("student_id", "concept_id", name="uq_retention_student_concept"),
        Index("ix_retention_student_concept", "student_id", "concept_id"),
    )


class InterventionCampaign(Base):
    __tablename__ = "intervention_campaigns"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    concept_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    chapter_id: Mapped[str | None] = mapped_column(String(36), index=True)
    coursework_id: Mapped[str | None] = mapped_column(String(36), index=True)
    reason: Mapped[str] = mapped_column(String(80), nullable=False)
    priority: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    recommended_action: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    snapshot_id: Mapped[str | None] = mapped_column(String(36), index=True)
    correlation_id: Mapped[str | None] = mapped_column(String(200), index=True)
    decision_source: Mapped[str] = mapped_column(String(24), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(240), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(24), default="active", nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_campaign_student_status_priority", "student_id", "status", "priority"),
    )


class InterventionDelivery(Base):
    __tablename__ = "intervention_deliveries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    campaign_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    student_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    surface: Mapped[str] = mapped_column(String(24), nullable=False)
    event_type: Mapped[str] = mapped_column(String(24), nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(128))
    idempotency_key: Mapped[str] = mapped_column(String(240), nullable=False, unique=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class CampaignProjection(Base):
    __tablename__ = "campaign_projections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    campaign_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    target: Mapped[str] = mapped_column(String(24), nullable=False, default="notification")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    last_error: Mapped[str | None] = mapped_column(String(1000))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("campaign_id", "target", name="uq_campaign_projection_target"),
    )
