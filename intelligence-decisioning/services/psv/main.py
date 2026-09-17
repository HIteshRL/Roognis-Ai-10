from __future__ import annotations
from scoring import RULE_VERSION

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from auth import AuthUser, require_internal_token, require_student
from config import Settings, get_settings
from database import SessionLocal, get_db, init_db
from models import InterventionCampaign, KnowledgeGapSnapshot, LearningEvent, RefreshRun, RetentionState
from schemas import AggregateRequest, EventBatchInput, InternalEventBatchInput
from service import erase_student_state, persist_events, recompute_student, run_daily_refresh
import campaigns
from campaigns import process_campaign_projections


async def daily_refresh_loop(settings: Settings) -> None:
    # The database run-key lease makes this safe across replicas. Polling is
    # intentionally coarse; evidence is captured immediately but model state
    # changes on the documented daily cadence.
    await asyncio.sleep(30)
    while True:
        now = datetime.now(timezone.utc)
        if now.hour >= settings.daily_refresh_hour_utc:
            run_key = f"academic:{now.date().isoformat()}"
            def run() -> None:
                with SessionLocal() as db:
                    run_daily_refresh(db, settings, run_key)
            try:
                await asyncio.to_thread(run)
            except Exception as exc:
                print(f"[psv] daily refresh failed: {exc}", flush=True)
        await asyncio.sleep(max(300, settings.daily_refresh_poll_seconds))


async def campaign_projection_loop(settings: Settings) -> None:
    while True:
        try:
            await asyncio.to_thread(_run_campaign_projection, settings)
        except Exception as exc:
            print(f"[psv] campaign projection failed: {exc}", flush=True)
        await asyncio.sleep(max(2, settings.campaign_projection_poll_seconds))


def _run_campaign_projection(settings: Settings) -> None:
    with SessionLocal() as db:
        process_campaign_projections(db, settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    # Deliberately check before connecting to or mutating the PSV database.
    # An unapproved shared-environment deployment must fail its startup probe
    # rather than becoming a dormant-but-reachable intervention service.
    settings.require_deployment_approval()
    init_db()
    tasks = []
    if settings.daily_refresh_enabled:
        tasks.append(asyncio.create_task(daily_refresh_loop(settings)))
    if settings.campaign_projection_enabled and not settings.database_url.startswith("sqlite"):
        tasks.append(asyncio.create_task(campaign_projection_loop(settings)))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Roognis PSV Service", lifespan=lifespan)
app.include_router(campaigns.router)


@app.get("/health")
@app.get("/api/psv/health")
def health(db: Session = Depends(get_db)):
    latest = db.scalar(select(RefreshRun).where(RefreshRun.status == "done").order_by(RefreshRun.completed_at.desc()))
    return {
        "status": "ok",
        "service": "psv",
        "lastSuccessfulRefreshAt": latest.completed_at if latest else None,
        "academicTrainingStatus": latest.training_status if latest else None,
        "academicTrainingReason": latest.training_reason if latest else None,
    }


@app.post("/api/psv/v1/events/batch", status_code=status.HTTP_202_ACCEPTED)
def ingest_student_events(
    body: EventBatchInput,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    for event in body.events:
        if event.student_id and event.student_id != user.user_id:
            raise HTTPException(status_code=403, detail="Event studentId does not match the authenticated student.")
        if event.school_id and event.school_id != user.school_id:
            raise HTTPException(status_code=403, detail="Event schoolId does not match the authenticated school.")
    try:
        return persist_events(db, body.events, student_id=user.user_id, school_id=user.school_id)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/psv/internal/events/batch", status_code=status.HTTP_202_ACCEPTED)
def ingest_internal_events(
    body: InternalEventBatchInput,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    try:
        result = persist_events(db, body.events, trusted=True)
        updated = 0
        for student_id, school_id in sorted({(event.student_id, event.school_id) for event in body.events}):
            updated += recompute_student(db, get_settings(), student_id=student_id, school_id=school_id)
        return {**result, "conceptsUpdated": updated}
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def serialize_gap(
    row: KnowledgeGapSnapshot,
    retention: RetentionState | None = None,
    *,
    include_provenance: bool = False,
) -> dict:
    """include_provenance is off for the student route and on for the internal
    one: raw event ids are an auditor's tool with no student-facing consumer,
    and CLAUDE.md forbids any teacher/parent view of this data regardless."""
    payload = {
        "conceptId": row.concept_id,
        "conceptLabel": row.concept_label,
        "trend": row.trend,
        "confidenceKind": "evidence_coverage_heuristic",
        "snapshotAgeSeconds": max(0, (datetime.now(timezone.utc) - row.computed_at.replace(tzinfo=timezone.utc)).total_seconds()),
        "mastery": row.mastery,
        "recallStability": row.recall_stability,
        "difficultyReadiness": row.difficulty_readiness,
        "nextDifficulty": row.next_difficulty,
        "nextConceptId": row.next_concept_id or row.concept_id,
        "scaffold": row.scaffold,
        "gapScore": row.gap_score,
        "confidence": row.confidence,
        "uncertainty": row.uncertainty,
        "evidenceCount": row.evidence_count,
        "decisionSource": row.decision_source,
        "ruleVersion": row.rule_version,
        "modelVersion": row.model_version,
        "correlationId": row.correlation_id,
        "lastEvidenceAt": row.last_evidence_at,
        "computedAt": row.computed_at,
    }
    if include_provenance:
        # §6.2: the events this row was derived from and the gate that admitted
        # them. Bounded to the decision contract's 200; the complete set is a
        # query against the append-only EvidenceRecord ledger.
        payload["eventIds"] = list(row.event_ids or [])
        payload["gateVersion"] = row.gate_version
    if retention:
        payload["retention"] = serialize_retention(retention, include_provenance=include_provenance)
    return payload


def serialize_retention(row: RetentionState, *, include_provenance: bool = False) -> dict:
    payload = {
        "conceptId": row.concept_id,
        "anchorStrength": row.anchor_strength,
        "anchorAt": row.anchor_at,
        "thetaMeanPerDay": row.theta_mean_per_day,
        "thetaStdDev": row.theta_std_dev,
        "halfLifeDays": row.half_life_days,
        "predictedRecallNow": row.predicted_recall_now,
        "predictedRecall24h": row.predicted_recall_24h,
        "predictedRecall7d": row.predicted_recall_7d,
        "nextReviewAt": row.next_review_at,
        "evidenceCount": row.evidence_count,
        "delayedRetrievalCount": row.delayed_retrieval_count,
        "distinctItemCount": row.distinct_item_count,
        "coverageStatus": row.coverage_status,
        "ruleVersion": row.rule_version,
        "modelVersion": row.model_version,
        "correlationId": row.correlation_id,
        "lastEvidenceAt": row.last_evidence_at,
        "computedAt": row.computed_at,
    }
    if include_provenance:
        payload["eventIds"] = list(row.event_ids or [])
        payload["gateVersion"] = row.gate_version
        payload["decisionSource"] = row.decision_source
    return payload


@app.get("/api/psv/v1/me/retention")
def my_retention(user: AuthUser = Depends(require_student), db: Session = Depends(get_db)):
    rows = db.scalars(select(RetentionState).where(
        RetentionState.student_id == user.user_id,
        RetentionState.school_id == user.school_id,
    ).order_by(RetentionState.next_review_at.asc())).all()
    return {"studentId": user.user_id, "retention": [serialize_retention(row) for row in rows]}


@app.get("/api/psv/v1/me/knowledge-gaps")
def my_knowledge_gaps(
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    rows = db.scalars(select(KnowledgeGapSnapshot).where(
        KnowledgeGapSnapshot.student_id == user.user_id,
        KnowledgeGapSnapshot.school_id == user.school_id,
        KnowledgeGapSnapshot.rule_version == RULE_VERSION,
    ).order_by(KnowledgeGapSnapshot.gap_score.desc())).all()
    retention = {row.concept_id: row for row in db.scalars(select(RetentionState).where(
        RetentionState.student_id == user.user_id,
        RetentionState.school_id == user.school_id,
    )).all()}
    return {"studentId": user.user_id, "knowledgeGaps": [serialize_gap(row, retention.get(row.concept_id)) for row in rows]}


@app.delete("/api/psv/v1/me")
def delete_my_academic_state(
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    erase_student_state(db, student_id=user.user_id)
    return {"deleted": True}


@app.get("/api/psv/internal/student-snapshot")
def internal_student_snapshot(
    student_id: str = Query(alias="studentId"),
    school_id: str = Query(alias="schoolId"),
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    rows = db.scalars(select(KnowledgeGapSnapshot).where(
        KnowledgeGapSnapshot.student_id == student_id,
        KnowledgeGapSnapshot.school_id == school_id,
        KnowledgeGapSnapshot.rule_version == RULE_VERSION,
    ).order_by(KnowledgeGapSnapshot.gap_score.desc()).limit(12)).all()
    retention = {row.concept_id: row for row in db.scalars(select(RetentionState).where(
        RetentionState.student_id == student_id,
        RetentionState.school_id == school_id,
    )).all()}
    return {"studentId": student_id, "knowledgeGaps": [
        serialize_gap(row, retention.get(row.concept_id), include_provenance=True) for row in rows
    ]}


@app.post("/api/psv/internal/knowledge-gaps/aggregate")
def internal_aggregate(
    body: AggregateRequest,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(
            KnowledgeGapSnapshot.concept_id,
            func.count(func.distinct(KnowledgeGapSnapshot.student_id)),
            func.avg(KnowledgeGapSnapshot.mastery),
            func.avg(KnowledgeGapSnapshot.gap_score),
            func.avg(KnowledgeGapSnapshot.confidence),
        ).where(
            KnowledgeGapSnapshot.school_id == body.school_id,
            KnowledgeGapSnapshot.rule_version == RULE_VERSION,
            KnowledgeGapSnapshot.student_id.in_(body.student_ids),
        ).group_by(KnowledgeGapSnapshot.concept_id)
    ).all()
    return {
        "cohortSize": len(set(body.student_ids)),
        "concepts": [
            {
                "conceptId": concept_id,
                "studentCount": int(student_count),
                "averageMastery": float(average_mastery or 0),
                "averageGapScore": float(average_gap or 0),
                "averageConfidence": float(average_confidence or 0),
            }
            for concept_id, student_count, average_mastery, average_gap, average_confidence in rows
        ],
    }


@app.post("/api/psv/internal/recompute")
def recompute(
    student_id: str | None = Query(default=None, alias="studentId"),
    school_id: str | None = Query(default=None, alias="schoolId"),
    run_key: str | None = Query(default=None, alias="runKey"),
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    if student_id or school_id:
        if not student_id or not school_id:
            raise HTTPException(status_code=400, detail="studentId and schoolId must be provided together.")
        return {
            "studentId": student_id,
            "conceptsUpdated": recompute_student(db, settings, student_id=student_id, school_id=school_id),
        }
    key = run_key or f"academic:{datetime.now(timezone.utc).date().isoformat()}"
    return run_daily_refresh(db, settings, key)


@app.get("/api/psv/internal/events/count")
def event_count(
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    return {"count": db.scalar(select(func.count()).select_from(LearningEvent)) or 0}


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


IMMEDIATE_PATH_TARGET_SECONDS = 60


@app.get("/api/psv/internal/immediate-path/stats")
def immediate_path_stats(
    hours: int = Query(default=24, ge=1, le=168),
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    """Observability for §5's "snapshot + campaign within 60s of ingest".

    Latency is measured as campaign.created_at − received_at of the
    authoritative event that shares its correlation id. The internal ingest
    endpoint recomputes synchronously, so this is normally sub-second; a growing
    tail means the synchronous path is regressing or a worker crept in.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    campaigns = db.scalars(
        select(InterventionCampaign).where(InterventionCampaign.created_at >= since)
    ).all()
    latencies: list[float] = []
    for campaign in campaigns:
        if not campaign.correlation_id:
            continue
        event = db.scalar(
            select(LearningEvent)
            .where(
                LearningEvent.student_id == campaign.student_id,
                or_(
                    LearningEvent.result_ref == campaign.correlation_id,
                    LearningEvent.attempt_id == campaign.correlation_id,
                    LearningEvent.event_id == campaign.correlation_id,
                ),
            )
            .order_by(LearningEvent.received_at.asc())
        )
        if not event or not event.received_at:
            continue
        delta = (_as_utc(campaign.created_at) - _as_utc(event.received_at)).total_seconds()
        if delta >= 0:
            latencies.append(delta)
    latencies.sort()

    def percentile(fraction: float) -> float | None:
        if not latencies:
            return None
        index = min(len(latencies) - 1, int(round(fraction * (len(latencies) - 1))))
        return latencies[index]

    return {
        "windowHours": hours,
        "targetSeconds": IMMEDIATE_PATH_TARGET_SECONDS,
        "campaigns": len(campaigns),
        "correlatedCampaigns": len(latencies),
        "withinTarget": sum(1 for value in latencies if value <= IMMEDIATE_PATH_TARGET_SECONDS),
        "exceededTarget": sum(1 for value in latencies if value > IMMEDIATE_PATH_TARGET_SECONDS),
        "latencySecondsP50": percentile(0.5),
        "latencySecondsP95": percentile(0.95),
        "latencySecondsMax": latencies[-1] if latencies else None,
    }
