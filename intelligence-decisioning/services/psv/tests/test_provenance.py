"""§6.2: no learner-state write without event_ids[], gate_version, model_version.

These tests exist because `compute_baseline` computed `evidence_ids` and the
write path discarded it, so every trait, snapshot and retention row in the
system claimed a model version but could not name the evidence behind it.
"""
from datetime import datetime, timedelta, timezone
import uuid

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from config import Settings
from database import Base
from models import (
    DecisionRecord,
    KnowledgeGapSnapshot,
    LearningEvent,
    RetentionState,
    TraitState,
)
from schemas import InternalEventBatchInput
from scoring import MAX_STATE_EVENT_IDS, PSV_GATE_RULES_VERSION, THETA_RULE_VERSION
from service import persist_events, recompute_student

# Every table that holds derived learner state. A new one added here without the
# three provenance columns fails test_every_learner_state_table_declares_provenance.
LEARNER_STATE_TABLES = (TraitState, KnowledgeGapSnapshot, RetentionState)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = Session(engine)
    yield session
    session.close()


@pytest.fixture
def settings():
    # Blanking the service URLs exercises the deterministic fallback path, which
    # is what a real deployment runs today: both GNN artifacts are unpromoted.
    return Settings(
        internal_service_token="test-internal",
        gnn_service_url="",
        gnn_trainer_url="",
        kg_service_url="",
        decision_service_url="",
        campaign_projection_enabled=False,
    )


def scored_event(*, concept="concept:cells", item="item-1", score=0.3, days_ago=0):
    when = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "schemaVersion": 1,
        "eventId": str(uuid.uuid4()),
        "eventType": "written_answer_scored",
        "source": "lms",
        "studentId": "student-a",
        "schoolId": "school-a",
        "itemId": item,
        "conceptId": concept,
        "clientTsMono": 0,
        "clientTsWall": when.isoformat(),
        "payload": {
            "scoreNormalized": score,
            "resultRef": f"grade-{item}",
            "gradingAuthority": "lms-service",
            "difficulty": "medium",
        },
    }


def ingest(db, payloads):
    batch = InternalEventBatchInput.model_validate({"events": payloads})
    return persist_events(db, batch.events, student_id="student-a", school_id="school-a", trusted=True)


def test_every_learner_state_table_declares_provenance():
    """Structural guard: the only test here that generalises to future tables."""
    for model in LEARNER_STATE_TABLES:
        columns = set(model.__table__.columns.keys())
        missing = {"event_ids", "gate_version", "model_version"} - columns
        assert not missing, f"{model.__tablename__} is missing provenance columns: {missing}"
        assert not model.__table__.columns["gate_version"].nullable, (
            f"{model.__tablename__}.gate_version must be NOT NULL — a nullable "
            "provenance column is a null provenance column"
        )


def test_every_learner_state_write_carries_event_ids_gate_and_model_version(db, settings):
    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    assert recompute_student(db, settings, student_id="student-a", school_id="school-a") == 1

    known_event_ids = set(db.scalars(select(LearningEvent.event_id)).all())
    assert known_event_ids

    for model in LEARNER_STATE_TABLES:
        rows = db.scalars(select(model)).all()
        assert rows, f"expected at least one {model.__tablename__} row"
        for row in rows:
            assert isinstance(row.event_ids, list) and row.event_ids, (
                f"{model.__tablename__} row has empty event_ids"
            )
            assert all(isinstance(e, str) for e in row.event_ids)
            # Provenance must point at events that actually exist.
            assert set(row.event_ids) <= known_event_ids, (
                f"{model.__tablename__} cites event ids with no matching LearningEvent"
            )
            assert row.gate_version and row.gate_version != "legacy-unversioned"
            assert row.gate_version.startswith(PSV_GATE_RULES_VERSION)
            # model_version and decision_source must never be jointly ambiguous.
            if row.model_version is None:
                assert getattr(row, "decision_source", "baseline") == "baseline"


def test_trait_event_ids_match_the_decision_that_caused_the_write(db, settings):
    """The regression test for evidence_ids being computed and then discarded."""
    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")

    decision = db.scalars(select(DecisionRecord)).one()
    traits = db.scalars(select(TraitState).where(TraitState.concept_id == decision.concept_id)).all()
    assert traits
    for trait in traits:
        assert trait.event_ids == decision.evidence_ids[-MAX_STATE_EVENT_IDS:]
        assert trait.gate_version == decision.gate_version


def test_state_event_ids_are_bounded_to_the_decision_contract(db, settings):
    """Beyond 200 was never an input to the gate, so it must not be claimed."""
    total = MAX_STATE_EVENT_IDS + 50
    ingest(db, [scored_event(item=f"item-{i}", days_ago=total - i) for i in range(total)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")

    trait = db.scalars(select(TraitState)).first()
    assert len(trait.event_ids) == MAX_STATE_EVENT_IDS
    # Truncation stays visible without a dedicated column.
    assert trait.evidence_count > len(trait.event_ids)

    ordered = db.scalars(
        select(LearningEvent.event_id).order_by(LearningEvent.client_ts_wall.asc())
    ).all()
    assert trait.event_ids == ordered[-MAX_STATE_EVENT_IDS:], "must retain the most recent ids"


def test_retention_gate_is_the_theta_gate_not_the_decision_gate(db, settings):
    """Retention is admitted by theta activation, with no decision-layer involvement.

    Pinned deliberately so a later 'unification' of the version strings has to
    argue with a test rather than silently mislabel what admitted the row.
    """
    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")

    retention = db.scalars(select(RetentionState)).one()
    snapshot = db.scalars(select(KnowledgeGapSnapshot)).one()
    assert THETA_RULE_VERSION in retention.gate_version
    assert THETA_RULE_VERSION not in snapshot.gate_version


def test_gate_version_records_an_unreachable_decision_service(db, settings):
    """A missing decision service must be visible in the data, not papered over.

    PSV's local fallback reports the estimator's own ruleVersion, so ruleVersion
    alone cannot distinguish it from a real decision-service answer that happened
    to prefer the baseline. decisionPath is what makes the two distinguishable.
    """
    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")

    snapshot = db.scalars(select(KnowledgeGapSnapshot)).one()
    assert "psv-local-fallback" in snapshot.gate_version
    assert "decision-service" not in snapshot.gate_version.replace("psv-local-fallback", "")
    assert snapshot.decision_source == "baseline"


def test_gate_version_distinguishes_a_real_decision_service_answer(db, settings, monkeypatch):
    """The same assertion from the other side: a served decision is labelled as one."""
    import decision_client

    def fake_post(url, **kwargs):
        class Response:
            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                body = kwargs["json"]
                return {
                    "conceptId": body["conceptId"],
                    "mastery": 0.9,
                    "difficultyReadiness": 0.9,
                    "nextDifficulty": "hard",
                    "scaffold": "open_problem",
                    "source": "gnn",
                    "ruleVersion": "dual-graph-decisions-v1",
                    "modelVersion": "knowledge-test-1",
                    "evidenceIds": body["evidenceIds"],
                }

        return Response()

    monkeypatch.setattr(decision_client.httpx, "post", fake_post)
    served = settings.model_copy(update={"decision_service_url": "http://decisions:3014"})

    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, served, student_id="student-a", school_id="school-a")

    snapshot = db.scalars(select(KnowledgeGapSnapshot)).one()
    assert snapshot.gate_version == (
        f"{PSV_GATE_RULES_VERSION}+decision-service+dual-graph-decisions-v1"
    )
    # A model that actually influenced the row must be named on it.
    assert snapshot.decision_source == "gnn"
    assert snapshot.model_version == "knowledge-test-1"
    trait = db.scalars(select(TraitState)).first()
    assert trait.decision_source == "gnn"
    assert trait.model_version == "knowledge-test-1"


def test_raw_event_ids_are_internal_only(db, settings):
    """Provenance is an auditor's tool. The student route has no consumer for raw
    event ids, and CLAUDE.md forbids any teacher/parent view of this data, so the
    ids are exposed on the internal-token route only."""
    from main import serialize_gap
    from sqlalchemy import select as sa_select

    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")
    row = db.scalars(sa_select(KnowledgeGapSnapshot)).one()

    student_view = serialize_gap(row)
    internal_view = serialize_gap(row, include_provenance=True)

    assert "eventIds" not in student_view and "gateVersion" not in student_view
    assert internal_view["eventIds"] and internal_view["gateVersion"]
    # The student still sees which model shaped their own state.
    assert "modelVersion" in student_view and "decisionSource" in student_view


def test_recompute_overwrites_a_legacy_provenance_sentinel(db, settings):
    """Re-running recompute is the backfill; the sentinel must not survive it."""
    ingest(db, [scored_event(item=f"item-{i}", days_ago=6 - i) for i in range(4)])
    recompute_student(db, settings, student_id="student-a", school_id="school-a")

    trait = db.scalars(select(TraitState)).first()
    trait.event_ids = []
    trait.gate_version = "legacy-unversioned"
    db.commit()

    recompute_student(db, settings, student_id="student-a", school_id="school-a")
    db.refresh(trait)
    assert trait.event_ids
    assert trait.gate_version != "legacy-unversioned"
