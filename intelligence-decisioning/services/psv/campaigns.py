"""Cross-surface intervention campaign delivery.

A campaign is a single recommendation identity. Surfaces record delivery and
interaction separately; completion transitions the shared campaign so every
other surface stops offering it.

*** NOT APPROVED FOR PRODUCTION DEPLOYMENT ***
This "retention campaign" system (this module) calls
POST /api/lms/internal/notifications/batch on the LMS service
(lms-services-backend) to push notifications to students/parents. It was
discovered by tracing an unexplained endpoint during a pre-launch cleanup
pass, not requested by anyone, and is undocumented product scope. Do not
wire this module up to a running deployment, and do not stand up
services/psv in production, until a founder has reviewed and explicitly
approved it. The LMS-side endpoint it calls is token-gated and fails closed
if nothing calls it, so leaving this dormant is safe; shipping it
unreviewed, days before launch, is not. See this repo's README ("Flag:
doc-vs-code discrepancy" section) for the fuller context.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import AuthUser, require_internal_token, require_student
from config import Settings
from database import get_db
from models import CampaignProjection, InterventionCampaign, InterventionDelivery

router = APIRouter(prefix="/api/psv", tags=["interventions"])
SURFACES = {"tutor", "discover", "notifications", "lms", "portal"}
EVENTS = {"delivered", "opened", "dismissed", "postponed", "started", "completed"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def serialize_campaign(row: InterventionCampaign) -> dict:
    return {
        "campaignId": row.id,
        "studentId": row.student_id,
        "conceptId": row.concept_id,
        "chapterId": row.chapter_id,
        "courseworkId": row.coursework_id,
        "reason": row.reason,
        "priority": row.priority,
        "recommendedAction": row.recommended_action,
        "snapshotId": row.snapshot_id,
        "correlationId": row.correlation_id,
        "decisionSource": row.decision_source,
        "createdAt": row.created_at,
        "expiresAt": row.expires_at,
        "status": row.status,
    }


def _active_query(student_id: str, school_id: str):
    return select(InterventionCampaign).where(
        InterventionCampaign.student_id == student_id,
        InterventionCampaign.school_id == school_id,
        InterventionCampaign.status == "active",
        InterventionCampaign.expires_at > _now(),
    ).order_by(InterventionCampaign.priority.desc(), InterventionCampaign.created_at.asc())


def _record(
    db: Session,
    *,
    campaign: InterventionCampaign,
    surface: str,
    event_type: str,
    idempotency_key: str,
    session_id: str | None,
    occurred_at: datetime | None = None,
) -> bool:
    if surface not in SURFACES or event_type not in EVENTS:
        raise ValueError("Unknown intervention surface or event")
    try:
        with db.begin_nested():
            db.add(InterventionDelivery(
                campaign_id=campaign.id,
                student_id=campaign.student_id,
                surface=surface,
                event_type=event_type,
                idempotency_key=idempotency_key,
                session_id=session_id,
                occurred_at=occurred_at or _now(),
            ))
            db.flush()
        return True
    except IntegrityError:
        return False


def available_campaigns(
    db: Session,
    *,
    student_id: str,
    school_id: str,
    surface: str,
    session_id: str | None = None,
) -> list[InterventionCampaign]:
    if surface not in SURFACES:
        raise HTTPException(status_code=400, detail="Unknown intervention surface.")
    if surface == "tutor":
        if not session_id:
            raise HTTPException(status_code=400, detail="sessionId is required for tutor delivery.")
        already_prompted = db.scalar(select(InterventionDelivery.id).where(
            InterventionDelivery.student_id == student_id,
            InterventionDelivery.surface == "tutor",
            InterventionDelivery.session_id == session_id,
            InterventionDelivery.event_type == "delivered",
        ))
        if already_prompted:
            return []
    rows = list(db.scalars(_active_query(student_id, school_id).limit(10)).all())
    if surface == "tutor" and rows:
        _record(db, campaign=rows[0], surface=surface, event_type="delivered",
                session_id=session_id, idempotency_key=f"tutor-delivered:{session_id}")
        db.commit()
        return rows[:1]
    return rows


@router.get("/v1/me/interventions")
def my_interventions(
    surface: str = Query(default="portal"),
    session_id: str | None = Query(default=None, alias="sessionId"),
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    rows = available_campaigns(db, student_id=user.user_id, school_id=user.school_id,
                               surface=surface, session_id=session_id)
    return {"campaigns": [serialize_campaign(row) for row in rows]}


@router.get("/internal/student-interventions")
def internal_interventions(
    student_id: str = Query(alias="studentId"),
    school_id: str = Query(alias="schoolId"),
    surface: str = Query(default="lms"),
    session_id: str | None = Query(default=None, alias="sessionId"),
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    rows = available_campaigns(db, student_id=student_id, school_id=school_id,
                               surface=surface, session_id=session_id)
    return {"campaigns": [serialize_campaign(row) for row in rows]}


class CampaignEventBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    surface: str
    event_type: str = Field(alias="eventType")
    idempotency_key: str = Field(alias="idempotencyKey", min_length=8, max_length=240)
    session_id: str | None = Field(default=None, alias="sessionId", max_length=128)
    occurred_at: datetime | None = Field(default=None, alias="occurredAt")


def record_campaign_event(
    db: Session,
    *,
    campaign_id: str,
    student_id: str,
    school_id: str,
    body: CampaignEventBody,
) -> dict:
    campaign = db.scalar(select(InterventionCampaign).where(
        InterventionCampaign.id == campaign_id,
        InterventionCampaign.student_id == student_id,
        InterventionCampaign.school_id == school_id,
    ))
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found.")
    try:
        accepted = _record(db, campaign=campaign, surface=body.surface,
                           event_type=body.event_type, idempotency_key=body.idempotency_key,
                           session_id=body.session_id, occurred_at=body.occurred_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.event_type == "completed" and campaign.status == "active":
        campaign.status = "completed"
        campaign.completed_at = body.occurred_at or _now()
    elif body.event_type == "dismissed" and campaign.status == "active":
        campaign.status = "dismissed"
    db.commit()
    return {"campaignId": campaign.id, "status": campaign.status,
            "accepted": accepted, "deduplicated": not accepted}


@router.post("/v1/interventions/{campaign_id}/events")
def student_campaign_event(
    campaign_id: str,
    body: CampaignEventBody,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    return record_campaign_event(db, campaign_id=campaign_id, student_id=user.user_id,
                                 school_id=user.school_id, body=body)


@router.post("/internal/interventions/{campaign_id}/events")
def internal_campaign_event(
    campaign_id: str,
    student_id: str = Query(alias="studentId"),
    school_id: str = Query(alias="schoolId"),
    body: CampaignEventBody = ...,  # type: ignore[assignment]
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    return record_campaign_event(db, campaign_id=campaign_id, student_id=student_id,
                                 school_id=school_id, body=body)


def process_campaign_projections(db: Session, settings: Settings, *, limit: int = 50) -> dict:
    now = _now()
    query = select(CampaignProjection).where(
        CampaignProjection.status == "pending",
        CampaignProjection.available_at <= now,
    ).order_by(CampaignProjection.available_at.asc()).limit(limit)
    if db.get_bind().dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    projections = db.scalars(query).all()
    delivered = failed = suppressed = 0
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for projection in projections:
        campaign = db.scalar(select(InterventionCampaign).where(
            InterventionCampaign.id == projection.campaign_id,
        ))
        if not campaign or campaign.status != "active" or _aware(campaign.expires_at) <= now:
            projection.status = "suppressed"
            suppressed += 1
            continue
        already_notified = db.scalar(select(InterventionDelivery.id).where(
            InterventionDelivery.student_id == campaign.student_id,
            InterventionDelivery.surface == "notifications",
            InterventionDelivery.event_type == "delivered",
            InterventionDelivery.occurred_at >= day_start,
        ))
        if already_notified:
            projection.status = "suppressed"
            projection.last_error = "daily_notification_cap"
            suppressed += 1
            continue
        projection.attempt_count += 1
        try:
            response = httpx.post(
                f"{settings.lms_service_url.rstrip('/')}/api/lms/internal/notifications/batch",
                headers={"X-Internal-Service-Token": settings.internal_service_token},
                json={"notifications": [{
                    "userId": campaign.student_id,
                    "schoolId": campaign.school_id,
                    "type": "retention_review",
                    "title": "A quick review is ready",
                    "body": campaign.recommended_action.get("label", "Review this concept"),
                    "data": {"campaignId": campaign.id, "conceptId": campaign.concept_id,
                             "chapterId": campaign.chapter_id, "courseworkId": campaign.coursework_id},
                    "dedupeKey": f"campaign-notification:{campaign.id}",
                    "expiresAt": campaign.expires_at.isoformat(),
                }]},
                timeout=5,
            )
            response.raise_for_status()
            _record(db, campaign=campaign, surface="notifications", event_type="delivered",
                    idempotency_key=f"notification-delivered:{campaign.id}", session_id=None,
                    occurred_at=now)
            projection.status = "delivered"
            projection.delivered_at = now
            projection.last_error = None
            delivered += 1
        except Exception as exc:  # noqa: BLE001 - durable retry boundary
            projection.last_error = str(exc)[:1000]
            projection.available_at = now + timedelta(seconds=min(3600, 2 ** min(10, projection.attempt_count)))
            failed += 1
    db.commit()
    return {"selected": len(projections), "delivered": delivered,
            "failed": failed, "suppressed": suppressed}
