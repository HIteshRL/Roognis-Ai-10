import os
from datetime import datetime, timezone

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-token")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-that-is-at-least-thirty-two-bytes")

from fastapi.testclient import TestClient
import jwt

from main import app
from sources import SourceResult


def parent_token():
    return jwt.encode(
        {"userId": "parent-1", "role": "parent", "schoolId": "school-1"},
        "test-jwt-secret-that-is-at-least-thirty-two-bytes",
        algorithm="HS256",
    )


def test_policy_update_is_internal_only_and_versions_the_change():
    with TestClient(app) as client:
        assert client.get("/api/reporting/internal/policy").status_code == 401

        initial = client.get(
            "/api/reporting/internal/policy",
            headers={"X-Internal-Service-Token": "test-internal-token"},
        )
        assert initial.status_code == 200
        assert initial.json()["version"] == 1

        changed = client.put(
            "/api/reporting/internal/policy",
            headers={"X-Internal-Service-Token": "test-internal-token"},
            json={
                "updated_by": "reporting-operator",
                "parameters": {
                    "minimum_evidence_count": 3,
                    "minimum_confidence": 0.55,
                    "gap_score_threshold": 0.5,
                    "strength_mastery_threshold": 0.8,
                    "stale_after_days": 14,
                    "maximum_concepts": 4,
                },
            },
        )
        assert changed.status_code == 200
        assert changed.json()["version"] == 2
        assert changed.json()["parameters"]["minimum_evidence_count"] == 3


def test_parent_report_requires_a_live_link(monkeypatch):
    class DenyingSources:
        def __init__(self, _settings):
            pass

        def linked_student_ids(self, _parent_id, _school_id):
            return []

    monkeypatch.setattr("main.ReportSources", DenyingSources)
    with TestClient(app) as client:
        client.cookies.set("jwt", parent_token())
        response = client.get("/api/reporting/v1/parent/students/student-1")
    assert response.status_code == 403


def test_parent_report_removes_internal_psv_fields(monkeypatch):
    class Sources:
        def __init__(self, _settings):
            pass

        def linked_student_ids(self, _parent_id, _school_id):
            return ["student-1"]

        def analytics_parent_dashboard(self, _student_id, _jwt):
            return SourceResult({"latestQuizScorePercent": 72})

        def lms_guardian_summary(self, _student_id, _jwt):
            return SourceResult({"missing": [], "recentGrades": []})

        def psv_snapshot(self, _student_id, _school_id):
            return SourceResult({"knowledgeGaps": [{
                "conceptId": "fraction-comparison",
                "conceptLabel": "Fraction comparison",
                "mastery": 0.4,
                "gapScore": 0.7,
                "trend": -0.1,
                "confidence": 0.9,
                "evidenceCount": 4,
                "lastEvidenceAt": datetime.now(timezone.utc).isoformat(),
                "eventIds": ["private-evidence-id"],
                "modelVersion": "private-model-version",
                "decisionSource": "baseline",
            }]})

    monkeypatch.setattr("main.ReportSources", Sources)
    with TestClient(app) as client:
        client.cookies.set("jwt", parent_token())
        response = client.get("/api/reporting/v1/parent/students/student-1")
    assert response.status_code == 200
    concept = response.json()["academicSummary"]["concepts"][0]
    assert concept["status"] == "needs_practice"
    assert "eventIds" not in concept
    assert "modelVersion" not in concept
    assert "decisionSource" not in concept


def test_parent_report_is_explicitly_degraded_when_psv_is_disabled(monkeypatch):
    class Sources:
        def __init__(self, _settings):
            pass

        def linked_student_ids(self, _parent_id, _school_id):
            return ["student-1"]

        def analytics_parent_dashboard(self, _student_id, _jwt):
            return SourceResult({"latestQuizScorePercent": 72})

        def lms_guardian_summary(self, _student_id, _jwt):
            return SourceResult({"missing": [], "recentGrades": []})

        def psv_snapshot(self, _student_id, _school_id):
            return SourceResult(None, "academic-insights-disabled")

    monkeypatch.setattr("main.ReportSources", Sources)
    with TestClient(app) as client:
        client.cookies.set("jwt", parent_token())
        response = client.get("/api/reporting/v1/parent/students/student-1")

    assert response.status_code == 200
    body = response.json()
    assert body["academicSummary"] == {
        "available": False,
        "concepts": [],
        "insufficientEvidenceConceptCount": 0,
    }
    assert body["limitations"] == ["academic-insights-disabled"]
