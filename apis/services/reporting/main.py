from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy.orm import Session

from auth import AuthUser, require_internal_token, require_parent
from config import Settings, get_settings
from database import get_db, init_db
from models import ReportPolicy
from policy import POLICY_KEY, REPORT_CONTRACT_VERSION, build_academic_insights, default_parameters
from schemas import PolicyParameters, PolicyUpdate, PolicyView
from sources import ReportSources


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Roognis Reporting Service", lifespan=lifespan)


def load_policy(db: Session) -> ReportPolicy:
    row = db.get(ReportPolicy, POLICY_KEY)
    if row:
        return row
    row = ReportPolicy(
        policy_key=POLICY_KEY,
        version=1,
        parameters=default_parameters().model_dump(),
        updated_by="system-default",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def serialize_policy(row: ReportPolicy) -> dict:
    return {
        "version": row.version,
        "parameters": PolicyParameters.model_validate(row.parameters),
        "updated_at": row.updated_at,
    }


@app.get("/health")
@app.get("/api/reporting/health")
def health(db: Session = Depends(get_db)):
    policy = load_policy(db)
    return {"status": "ok", "service": "reporting", "reportContractVersion": REPORT_CONTRACT_VERSION, "policyVersion": policy.version}


@app.get("/api/reporting/internal/policy", response_model=PolicyView)
def get_policy(_: None = Depends(require_internal_token), db: Session = Depends(get_db)):
    return serialize_policy(load_policy(db))


@app.put("/api/reporting/internal/policy", response_model=PolicyView)
def update_policy(body: PolicyUpdate, _: None = Depends(require_internal_token), db: Session = Depends(get_db)):
    row = load_policy(db)
    row.version += 1
    row.parameters = body.parameters.model_dump()
    row.updated_by = body.updated_by
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return serialize_policy(row)


@app.get("/api/reporting/v1/parent/students/{student_id}")
def parent_student_report(
    student_id: str,
    parent: AuthUser = Depends(require_parent),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    """A parent-safe report assembled from source-owned APIs.

    The live link lookup prevents a revoked link from remaining usable through a
    stale JWT. PSV event identifiers and internal model metadata are removed by
    `build_academic_insights` before this response is returned.
    """
    sources = ReportSources(settings)
    if student_id not in sources.linked_student_ids(parent.user_id, parent.school_id):
        raise HTTPException(status_code=403, detail="You are not a guardian of this student.")

    policy_row = load_policy(db)
    parameters = PolicyParameters.model_validate(policy_row.parameters)
    analytics = sources.analytics_parent_dashboard(student_id, parent.jwt_cookie)
    coursework = sources.lms_guardian_summary(student_id, parent.jwt_cookie)
    academic = sources.psv_snapshot(student_id, parent.school_id)

    limitations = [result.unavailable for result in (analytics, coursework, academic) if result.unavailable]
    academic_summary = build_academic_insights((academic.data or {}).get("knowledgeGaps", []), parameters)
    if academic.unavailable:
        academic_summary = {"available": False, "concepts": [], "insufficientEvidenceConceptCount": 0}

    return {
        "contractVersion": REPORT_CONTRACT_VERSION,
        "studentId": student_id,
        "policy": {"version": policy_row.version, "parameters": parameters.model_dump()},
        "academicSummary": academic_summary,
        "learningActivity": analytics.data,
        "coursework": coursework.data,
        "limitations": limitations,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
