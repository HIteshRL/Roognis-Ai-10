from datetime import datetime, timezone

import httpx
from fastapi import Depends, FastAPI, HTTPException

from auth import TeacherAuth, require_teacher
from config import Settings, get_settings
from policy import privacy_filter_aggregate

app = FastAPI(title="Roognis Privacy Guard")
GATE_VERSION = "privacy-aggregate-v1"
RULESET_VERSION = "academic-class-aggregate-v1"


@app.get("/health")
@app.get("/api/privacy/health")
def health(settings: Settings = Depends(get_settings)):
    return {
        "status": "ok",
        "service": "privacy",
        "minimumCohortSize": settings.privacy_min_cohort_size,
    }


def _classroom_knowledge_gaps(
    classroom_id: str,
    teacher: TeacherAuth,
    settings: Settings,
):
    try:
        roster_response = httpx.get(
            f"{settings.lms_service_url.rstrip('/')}/api/lms/classrooms/{classroom_id}/students",
            cookies={"jwt": teacher.jwt_cookie},
            timeout=settings.upstream_timeout_seconds,
        )
        if roster_response.status_code in {401, 403, 404}:
            raise HTTPException(status_code=roster_response.status_code, detail="Classroom is not available to this teacher.")
        roster_response.raise_for_status()
        student_ids = [
            row.get("studentId")
            for row in roster_response.json().get("students", [])
            if isinstance(row.get("studentId"), str)
        ]
        if len(set(student_ids)) < settings.privacy_min_cohort_size:
            return privacy_filter_aggregate(
                {"cohortSize": len(set(student_ids)), "concepts": []},
                minimum_cohort_size=settings.privacy_min_cohort_size,
            )

        psv_response = httpx.post(
            f"{settings.psv_service_url.rstrip('/')}/api/psv/internal/knowledge-gaps/aggregate",
            json={"studentIds": student_ids, "schoolId": teacher.school_id},
            headers={"X-Internal-Service-Token": settings.internal_service_token},
            timeout=settings.upstream_timeout_seconds,
        )
        psv_response.raise_for_status()
        filtered = privacy_filter_aggregate(
            psv_response.json(),
            minimum_cohort_size=settings.privacy_min_cohort_size,
        )
        return {"classroomId": classroom_id, **filtered}
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Knowledge-gap aggregate is temporarily unavailable.") from exc


@app.get("/api/privacy/classes/{classroom_id}/knowledge-gaps")
def classroom_knowledge_gaps(
    classroom_id: str,
    teacher: TeacherAuth = Depends(require_teacher),
    settings: Settings = Depends(get_settings),
):
    return _classroom_knowledge_gaps(classroom_id, teacher, settings)


@app.get("/api/privacy/classrooms/{classroom_id}/aggregates/{aggregate_key}")
def guarded_classroom_aggregate(
    classroom_id: str,
    aggregate_key: str,
    teacher: TeacherAuth = Depends(require_teacher),
    settings: Settings = Depends(get_settings),
):
    if aggregate_key not in {"classroom-mastery", "concept-confusion"}:
        raise HTTPException(status_code=404, detail="Aggregate is not available.")
    filtered = _classroom_knowledge_gaps(classroom_id, teacher, settings)
    # Evidence identifiers intentionally remain empty: the teacher may verify
    # the disclosure gate/version, but raw PSV evidence ids never cross it.
    return {
        "data": {"concepts": filtered["concepts"], "suppressed": filtered["suppressed"]},
        "cohortSize": filtered["cohortSize"],
        "provenance": {
            "source": "psv-aggregate",
            "rulesetVersion": RULESET_VERSION,
            "gateVersion": GATE_VERSION,
            "computedAt": datetime.now(timezone.utc).isoformat(),
            "computedBy": "privacy-guard",
            "evidenceIds": [],
        },
    }
