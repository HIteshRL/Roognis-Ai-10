from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import Settings
from gnn_client import score_knowledge, load_concept_subgraph
from decision_client import decide_knowledge
from models import (
    CampaignProjection,
    DecisionRecord,
    EvidenceRecord,
    InterventionCampaign,
    InterventionDelivery,
    KnowledgeGapSnapshot,
    LearningEvent,
    RefreshRun,
    RetentionState,
    TraitState,
)
from schemas import LearningEventInput
from scoring import (
    MAX_STATE_EVENT_IDS,
    RULE_VERSION,
    TRAITS,
    classify_evidence_kind,
    compute_baseline,
    compute_theta_retention,
    correlation_key,
    evidence_from_event,
    effective_evidence,
    gate_version,
    retention_gate_version,
)
from training_client import train_knowledge_model


def _training_model_version(run_key: str) -> str:
    safe = "".join(char if char.isalnum() or char in "._-" else "-" for char in run_key).strip("-")
    return f"knowledge-{safe}"[:80]


def _is_reclaimable_refresh_lease(run: RefreshRun | None, observed_at: datetime) -> bool:
    if not run or run.status != "running" or not run.lease_expires_at:
        return False
    expires_at = run.lease_expires_at
    comparison_time = observed_at
    if expires_at.tzinfo is None:
        comparison_time = observed_at.replace(tzinfo=None)
    return expires_at <= comparison_time


def persist_events(db: Session, events: list[LearningEventInput], *, student_id: str | None = None, school_id: str | None = None, trusted: bool = False) -> dict:
    accepted: list[str] = []
    deduplicated: list[str] = []
    for item in events:
        resolved_student = student_id or item.student_id
        resolved_school = school_id or item.school_id
        if not resolved_student or not resolved_school:
            raise ValueError("studentId and schoolId are required for internal events")
        existing = db.scalar(select(LearningEvent).where(LearningEvent.event_id == item.event_id))
        if existing:
            if existing.student_id != resolved_student or existing.school_id != resolved_school:
                raise ValueError("Event identity conflict")
            deduplicated.append(item.event_id)
            continue
        record = LearningEvent(
            event_id=item.event_id,
            schema_version=item.schema_version,
            event_type=item.event_type,
            source=item.source,
            student_id=resolved_student,
            school_id=resolved_school,
            session_id=item.session_id,
            item_id=item.item_id,
            concept_id=item.concept_id,
            course_id=item.course_id,
            chapter_id=item.chapter_id,
            content_id=item.content_id,
            curriculum_version=item.curriculum_version,
            attempt_id=item.attempt_id,
            campaign_id=item.campaign_id,
            server_occurred_at=getattr(item, "server_occurred_at", None) if trusted else None,
            grading_authority=(getattr(item, "grading_authority", None) or item.payload.get("gradingAuthority")) if trusted else None,
            result_ref=(getattr(item, "result_ref", None) or item.payload.get("resultRef")) if trusted else None,
            source_service=getattr(item, "source_service", None) if trusted else None,
            evidence_kind=classify_evidence_kind(
                item.event_type, trusted=trusted, has_campaign=bool(item.campaign_id)
            ),
            client_ts_mono=item.client_ts_mono,
            client_ts_wall=item.client_ts_wall,
            payload={**item.payload, "_verified": trusted},
        )
        try:
            # A savepoint confines a concurrent duplicate to this event, not
            # the entire batch. The database unique constraint is authoritative.
            with db.begin_nested():
                db.add(record)
                db.flush()
            accepted.append(item.event_id)
        except IntegrityError:
            existing = db.scalar(select(LearningEvent).where(LearningEvent.event_id == item.event_id))
            if not existing or existing.student_id != resolved_student or existing.school_id != resolved_school:
                raise ValueError("Event identity conflict")
            deduplicated.append(item.event_id)
    db.commit()
    return {"acceptedEventIds": accepted + deduplicated, "accepted": len(accepted), "deduplicated": len(deduplicated)}


def _upsert_trait(
    db: Session,
    *,
    student_id: str,
    school_id: str,
    concept_id: str,
    trait: str,
    result: dict,
    value: float,
    source: str,
    model_version: str | None,
    event_ids: list[str],
    gate_version: str,
) -> None:
    # event_ids and gate_version are passed explicitly rather than read out of
    # `result`: `result` is the baseline dict, whose evidence_ids cover only this
    # concept, while the ids that belong on the row are the decision's — which
    # prerequisite_guard may legitimately have widened to a neighbouring concept.
    # Keeping them as parameters makes that difference visible at the call site.
    row = db.scalar(select(TraitState).where(
        TraitState.student_id == student_id,
        TraitState.concept_id == concept_id,
        TraitState.trait_type == trait,
    ))
    if row:
        row.version += 1
        row.value = value
        row.confidence = result["confidence"]
        row.evidence_count = result["evidence_count"]
        row.trend = result["trend"]
        row.rule_version = RULE_VERSION
        row.model_version = model_version
        row.event_ids = event_ids
        row.gate_version = gate_version
        row.decision_source = source
        row.last_evidence_at = result["last_evidence_at"]
    else:
        db.add(TraitState(
            student_id=student_id,
            school_id=school_id,
            concept_id=concept_id,
            trait_type=trait,
            value=value,
            confidence=result["confidence"],
            evidence_count=result["evidence_count"],
            trend=result["trend"],
            rule_version=RULE_VERSION,
            model_version=model_version,
            event_ids=event_ids,
            gate_version=gate_version,
            decision_source=source,
            last_evidence_at=result["last_evidence_at"],
        ))


def recompute_student(
    db: Session,
    settings: Settings,
    *,
    student_id: str,
    school_id: str,
    commit: bool = True,
) -> int:
    events = db.scalars(select(LearningEvent).where(
        LearningEvent.student_id == student_id,
        LearningEvent.school_id == school_id,
        LearningEvent.concept_id.is_not(None),
    ).order_by(LearningEvent.client_ts_wall.asc())).all()
    grouped: dict[str, list] = defaultdict(list)
    for event in events:
        evidence = evidence_from_event(event)
        if evidence:
            grouped[evidence.concept_id].append(evidence)

    baselines = {concept: compute_baseline(rows) for concept, rows in grouped.items()}
    campaign_candidates: list[dict] = []
    for concept_id, evidence_rows in grouped.items():
        evidence_rows = effective_evidence(evidence_rows)
        baseline = baselines[concept_id]
        retention = compute_theta_retention(evidence_rows)
        latest_trusted = next(
            (event for event in reversed(events)
             if event.concept_id == concept_id and (event.payload or {}).get("_verified") is True),
            None,
        )
        correlation_id = correlation_key(
            result_ref=getattr(latest_trusted, "result_ref", None),
            attempt_id=getattr(latest_trusted, "attempt_id", None),
            event_id=getattr(latest_trusted, "event_id", None),
        )
        graph = load_concept_subgraph(settings, concept_id)
        baseline["prerequisite_gaps"] = [
            {"conceptId": edge["fromId"], "mastery": baselines[edge["fromId"]]["mastery"],
             "evidenceIds": baselines[edge["fromId"]]["evidence_ids"][-100:]}
            for edge in (graph or {}).get("edges", [])
            if edge.get("relationship") == "PREREQUISITE_OF" and edge.get("toId") == concept_id
            and edge.get("fromId") in baselines and baselines[edge["fromId"]]["mastery"] < 0.4
        ]
        gnn = score_knowledge(
            settings,
            student_id=student_id,
            concept_id=concept_id,
            baseline=baseline,
            evidence=evidence_rows,
            retention=retention,
            neighbour_baselines=baselines,
        )
        values = {
            "mastery": baseline["mastery"],
            "recall_stability": baseline["recall_stability"],
            "difficulty_readiness": baseline["difficulty_readiness"],
        }
        decision = decide_knowledge(settings, concept_id=concept_id, baseline=baseline, gnn=gnn)
        decision_source = decision["source"]
        model_version = decision.get("modelVersion")

        # §6.2 provenance for every learner-state row written below. Prefer the
        # decision's evidence — prerequisite_guard may widen it with a weak
        # prerequisite's ids from a neighbouring concept, and those genuinely
        # influenced nextConceptId / scaffold / nextDifficulty. Fall back to the
        # baseline's own ids so a future decisions version that stops returning
        # evidenceIds degrades to narrower provenance rather than to none.
        state_event_ids = list(dict.fromkeys(
            decision.get("evidenceIds") or baseline["evidence_ids"]
        ))[-MAX_STATE_EVENT_IDS:]
        state_gate_version = gate_version(decision)
        if not state_event_ids:
            # An empty provenance list is the violation this exists to end, so
            # fail the concept loudly rather than writing an unattributed row.
            raise ValueError(
                f"refusing to write learner state for {student_id}/{concept_id} with no event_ids"
            )
        values.update({
            "mastery": float(decision["mastery"]),
            "difficulty_readiness": float(decision["difficultyReadiness"]),
        })
        # Recall is not a decision-service output; retain the auditable
        # evidence-weighted estimate rather than synthesizing one from mastery.
        db.add(DecisionRecord(
            student_id=student_id,
            school_id=school_id,
            concept_id=concept_id,
            decision_type="daily_knowledge_snapshot",
            decision={
                "mastery": decision["mastery"],
                "difficultyReadiness": decision["difficultyReadiness"],
                "nextDifficulty": decision["nextDifficulty"],
                "scaffold": decision["scaffold"],
                "nextConceptId": decision["nextConceptId"],
            },
            source=decision_source,
            rule_version=decision["ruleVersion"],
            model_version=model_version,
            evidence_ids=decision.get("evidenceIds", []),
            gate_version=state_gate_version,
        ))

        for row in evidence_rows:
            for trait in TRAITS:
                existing = db.scalar(select(EvidenceRecord.id).where(
                    EvidenceRecord.event_id == row.event_id,
                    EvidenceRecord.trait_type == trait,
                ))
                if not existing:
                    db.add(EvidenceRecord(
                        event_id=row.event_id,
                        student_id=student_id,
                        school_id=school_id,
                        concept_id=concept_id,
                        trait_type=trait,
                        outcome=row.outcome,
                        evidence_weight=row.weight,
                        rule_version=RULE_VERSION,
                        model_version=model_version,
                        observed_at=row.observed_at,
                    ))

        for trait, value in values.items():
            _upsert_trait(
                db,
                student_id=student_id,
                school_id=school_id,
                concept_id=concept_id,
                trait=trait,
                result=baseline,
                value=value,
                source=decision_source,
                model_version=model_version,
                event_ids=state_event_ids,
                gate_version=state_gate_version,
            )

        snapshot = db.scalar(select(KnowledgeGapSnapshot).where(
            KnowledgeGapSnapshot.student_id == student_id,
            KnowledgeGapSnapshot.concept_id == concept_id,
        ))
        gap_score = max(0.0, min(1.0, 1 - (0.65 * values["mastery"] + 0.2 * values["recall_stability"] + 0.15 * values["difficulty_readiness"])))
        snapshot_values = dict(
            concept_label=next((str(event.payload.get("conceptLabel"))[:240] for event in reversed(events)
                                if event.concept_id == concept_id and event.payload.get("_verified") is True and event.payload.get("conceptLabel")), "Assessed concept"),
            trend=baseline["trend"],
            school_id=school_id,
            mastery=values["mastery"],
            recall_stability=values["recall_stability"],
            difficulty_readiness=values["difficulty_readiness"],
            next_difficulty=decision["nextDifficulty"],
            next_concept_id=decision["nextConceptId"],
            scaffold=decision["scaffold"],
            gap_score=gap_score,
            confidence=baseline["confidence"],
            uncertainty=1 - baseline["confidence"],
            evidence_count=baseline["evidence_count"],
            decision_source=decision_source,
            rule_version=RULE_VERSION,
            model_version=model_version,
            event_ids=state_event_ids,
            gate_version=state_gate_version,
            correlation_id=correlation_id,
            last_evidence_at=baseline["last_evidence_at"],
            computed_at=datetime.now(timezone.utc),
        )
        if snapshot:
            for key, value in snapshot_values.items():
                setattr(snapshot, key, value)
        else:
            snapshot = KnowledgeGapSnapshot(student_id=student_id, concept_id=concept_id, **snapshot_values)
            db.add(snapshot)

        retention_row = db.scalar(select(RetentionState).where(
            RetentionState.student_id == student_id,
            RetentionState.concept_id == concept_id,
        ))
        retention_values = dict(
            school_id=school_id,
            anchor_strength=retention["anchor_strength"],
            anchor_at=retention["anchor_at"],
            theta_mean_per_day=retention["theta_mean_per_day"],
            theta_std_dev=retention["theta_std_dev"],
            half_life_days=retention["half_life_days"],
            predicted_recall_now=retention["predicted_recall_now"],
            predicted_recall_24h=retention["predicted_recall_24h"],
            predicted_recall_7d=retention["predicted_recall_7d"],
            next_review_at=retention["next_review_at"],
            evidence_count=retention["evidence_count"],
            delayed_retrieval_count=retention["delayed_retrieval_count"],
            distinct_item_count=retention["distinct_item_count"],
            coverage_status=retention["coverage_status"],
            rule_version=retention["rule_version"],
            model_version=model_version,
            event_ids=list(dict.fromkeys(retention.get("evidence_ids") or []))[-MAX_STATE_EVENT_IDS:],
            gate_version=retention_gate_version(retention),
            decision_source=decision_source,
            correlation_id=correlation_id,
            last_evidence_at=retention["last_evidence_at"],
            computed_at=datetime.now(timezone.utc),
        )
        if retention_row:
            for key, value in retention_values.items():
                setattr(retention_row, key, value)
        else:
            db.add(RetentionState(student_id=student_id, concept_id=concept_id, **retention_values))

        latest_event = next((event for event in reversed(events) if event.concept_id == concept_id), None)
        predicted = float(retention["predicted_recall_24h"])
        next_review = retention["next_review_at"]
        current_time = datetime.now(timezone.utc)
        if predicted < 0.8 or next_review <= current_time + timedelta(days=2):
            campaign_candidates.append({
                "concept_id": concept_id,
                "chapter_id": (latest_event.chapter_id or (latest_event.payload or {}).get("chapterId")) if latest_event else None,
                "coursework_id": (latest_event.payload or {}).get("courseworkId") if latest_event else None,
                "reason": "retention_risk" if retention["coverage_status"] == "active" else "spaced_review",
                "priority": max(0.0, min(1.0, 0.6 * gap_score + 0.4 * (1 - predicted))),
                "snapshot": snapshot,
                "decision_source": decision_source,
                "retention": retention,
                "correlation_id": correlation_id,
            })

    _create_next_campaign(
        db,
        student_id=student_id,
        school_id=school_id,
        candidates=campaign_candidates,
    )

    if commit:
        db.commit()
    else:
        db.flush()
    return len(grouped)


def _create_next_campaign(
    db: Session,
    *,
    student_id: str,
    school_id: str,
    candidates: list[dict],
) -> InterventionCampaign | None:
    now = datetime.now(timezone.utc)
    for row in db.scalars(select(InterventionCampaign).where(
        InterventionCampaign.student_id == student_id,
        InterventionCampaign.school_id == school_id,
        InterventionCampaign.status == "active",
    )).all():
        expiry = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
        if expiry <= now:
            row.status = "expired"

    active = db.scalar(select(InterventionCampaign).where(
        InterventionCampaign.student_id == student_id,
        InterventionCampaign.school_id == school_id,
        InterventionCampaign.status == "active",
        InterventionCampaign.expires_at > now,
    ).order_by(InterventionCampaign.priority.desc()))
    if active or not candidates:
        return active

    selected = max(candidates, key=lambda item: item["priority"])
    retention = selected["retention"]
    date_key = retention["next_review_at"].date().isoformat()
    dedupe_key = (
        f"review:{student_id}:{selected['concept_id']}:{date_key}:"
        f"{retention['rule_version']}"
    )
    existing = db.scalar(select(InterventionCampaign).where(
        InterventionCampaign.dedupe_key == dedupe_key,
    ))
    if existing:
        return existing
    db.flush()
    snapshot = selected["snapshot"]
    campaign = InterventionCampaign(
        student_id=student_id,
        school_id=school_id,
        concept_id=selected["concept_id"],
        chapter_id=selected["chapter_id"],
        coursework_id=selected["coursework_id"],
        reason=selected["reason"],
        priority=selected["priority"],
        recommended_action={
            "kind": "retrieval_check",
            "label": "Do a short recall check",
            "predictedRecall24h": retention["predicted_recall_24h"],
            "nextReviewAt": retention["next_review_at"].isoformat(),
        },
        snapshot_id=snapshot.id,
        correlation_id=selected.get("correlation_id"),
        decision_source=selected["decision_source"],
        dedupe_key=dedupe_key,
        expires_at=now + timedelta(days=7),
    )
    db.add(campaign)
    db.flush()
    db.add(CampaignProjection(campaign_id=campaign.id, target="notification"))
    return campaign


def run_daily_refresh(db: Session, settings: Settings, run_key: str) -> dict:
    # Hold a dedicated connection: session locks must not leak into a pool
    # after a commit. A second replica cannot reclaim a still-running job.
    if db.get_bind().dialect.name != "postgresql":
        return _run_daily_refresh(db, settings, run_key)
    with db.get_bind().connect() as lock:
        acquired = lock.scalar(text("SELECT pg_try_advisory_lock(hashtext('psv-daily-refresh'))"))
        if not acquired:
            return {"started": False, "status": "running", "runKey": run_key}
        try:
            return _run_daily_refresh(db, settings, run_key)
        finally:
            lock.execute(text("SELECT pg_advisory_unlock(hashtext('psv-daily-refresh'))"))


def _run_daily_refresh(db: Session, settings: Settings, run_key: str) -> dict:
    lease_started_at = datetime.now(timezone.utc)
    lease_expires_at = lease_started_at + timedelta(hours=2)
    run = RefreshRun(
        run_key=run_key,
        lane="academic",
        status="running",
        lease_expires_at=lease_expires_at,
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(RefreshRun).where(RefreshRun.run_key == run_key))
        reclaimable = _is_reclaimable_refresh_lease(existing, lease_started_at)
        if not reclaimable:
            return {"started": False, "status": existing.status if existing else "unknown", "runKey": run_key}
        claimed = db.execute(update(RefreshRun).where(
            RefreshRun.id == existing.id,
            RefreshRun.status == "running",
            RefreshRun.lease_expires_at <= lease_started_at,
        ).values(
            started_at=lease_started_at,
            lease_expires_at=lease_expires_at,
            error=None,
            training_status="not_started",
            training_promoted=False,
            training_reason=None,
            processed_students=0,
            completed_at=None,
        ))
        db.commit()
        if claimed.rowcount != 1:
            return {"started": False, "status": "running", "runKey": run_key}
        run = db.scalar(select(RefreshRun).where(RefreshRun.id == existing.id))

    students = db.execute(select(LearningEvent.student_id, LearningEvent.school_id).distinct()).all()
    try:
        training_events = db.scalars(select(LearningEvent).where(
            LearningEvent.concept_id.is_not(None),
        ).order_by(LearningEvent.client_ts_wall.asc())).all()
        training = train_knowledge_model(
            settings,
            training_events,
            model_version=_training_model_version(run_key),
        )
        for student_id, school_id in students:
            recompute_student(
                db,
                settings,
                student_id=student_id,
                school_id=school_id,
                commit=False,
            )
        run.status = "done"
        run.processed_students = len(students)
        run.training_status = "promoted" if training.get("promoted") else (
            "not_promoted" if training.get("attempted") else "skipped"
        )
        run.training_promoted = bool(training.get("promoted"))
        run.training_reason = training.get("reason")
        run.lease_expires_at = None
        run.completed_at = datetime.now(timezone.utc)
        db.commit()
        return {
            "started": True,
            "status": "done",
            "runKey": run_key,
            "processedStudents": len(students),
            "training": training,
        }
    except Exception as exc:
        db.rollback()
        run = db.scalar(select(RefreshRun).where(RefreshRun.run_key == run_key))
        if run:
            run.status = "failed"
            run.error = str(exc)[:1000]
            run.lease_expires_at = None
            run.completed_at = datetime.now(timezone.utc)
            db.commit()
        raise


def erase_student_state(db: Session, *, student_id: str) -> None:
    campaign_ids = list(db.scalars(select(InterventionCampaign.id).where(
        InterventionCampaign.student_id == student_id,
    )).all())
    if campaign_ids:
        db.execute(delete(CampaignProjection).where(CampaignProjection.campaign_id.in_(campaign_ids)))
        db.execute(delete(InterventionDelivery).where(InterventionDelivery.campaign_id.in_(campaign_ids)))
        db.execute(delete(InterventionCampaign).where(InterventionCampaign.id.in_(campaign_ids)))
    for model in (DecisionRecord, KnowledgeGapSnapshot, RetentionState, TraitState, EvidenceRecord, LearningEvent):
        db.execute(delete(model).where(model.student_id == student_id))
    db.commit()
