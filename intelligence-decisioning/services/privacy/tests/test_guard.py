"""Route-level tests for the Privacy Guard.

`test_policy.py` covers the pure filter. Nothing covered `main.py` — so the auth
boundary that stands between a teacher and per-student PSV state, the roster
pre-check, the aggregate whitelist and the upstream error forwarding were all
untested. This is the service CLAUDE.md names as mandatory before any
teacher/parent view over learner-derived data, so an untested gate is the gap
that matters most in this repo.
"""
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

import main
from config import Settings, get_settings
from main import app

SECRET = "test-secret"


def token(role="teacher", user_id="teacher-1", school_id="school-a", secret=SECRET):
    return jwt.encode(
        {
            "userId": user_id,
            "role": role,
            "schoolId": school_id,
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        secret,
        algorithm="HS256",
    )


@pytest.fixture
def settings():
    return Settings(
        jwt_secret=SECRET,
        internal_service_token="internal-token",
        lms_service_url="http://lms:3006",
        psv_service_url="http://psv:3011",
        privacy_min_cohort_size=5,
    )


@pytest.fixture
def client(settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("upstream", request=None, response=None)


def wire(monkeypatch, *, roster=None, aggregate=None, calls=None):
    """Stub the two upstream hops; `calls` records which were reached."""
    calls = calls if calls is not None else []

    def fake_get(url, **kwargs):
        calls.append(("lms", url, kwargs))
        return roster if roster is not None else FakeResponse(200, {"students": []})

    def fake_post(url, **kwargs):
        calls.append(("psv", url, kwargs))
        return aggregate if aggregate is not None else FakeResponse(200, {"cohortSize": 0, "concepts": []})

    monkeypatch.setattr(main.httpx, "get", fake_get)
    monkeypatch.setattr(main.httpx, "post", fake_post)
    return calls


def roster_of(n):
    return FakeResponse(200, {"students": [{"studentId": f"student-{i}"} for i in range(n)]})


# ── auth boundary ───────────────────────────────────────────────────────────

def test_unauthenticated_request_is_rejected(client):
    assert client.get("/api/privacy/classes/class-1/knowledge-gaps").status_code == 401


@pytest.mark.parametrize("role", ["student", "parent"])
def test_non_teacher_roles_are_forbidden(client, role):
    """A student or parent must never reach a classroom aggregate."""
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": token(role=role)}
    )
    assert response.status_code == 403


def test_a_token_signed_with_the_wrong_secret_is_rejected(client):
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps",
        cookies={"jwt": token(secret="not-the-secret")},
    )
    assert response.status_code == 401


# ── classroom ownership is delegated to LMS, not re-implemented ─────────────

@pytest.mark.parametrize("upstream_status", [401, 403, 404])
def test_classroom_ownership_denials_are_forwarded(client, monkeypatch, upstream_status):
    """Ownership is LMS's call. A teacher with a valid token but no claim on this
    classroom must not get data, and the denial must not become a 200 or a 503."""
    calls = wire(monkeypatch, roster=FakeResponse(upstream_status))
    response = client.get(
        "/api/privacy/classes/class-x/knowledge-gaps", cookies={"jwt": token()}
    )
    assert response.status_code == upstream_status
    assert [c[0] for c in calls] == ["lms"], "PSV must not be consulted after a denial"


def test_the_teachers_own_cookie_is_forwarded_to_lms(client, monkeypatch):
    """The roster is fetched as the teacher, so LMS enforces ownership against
    the real identity rather than the guard's service credentials."""
    calls = wire(monkeypatch, roster=roster_of(6))
    jwt_cookie = token()
    client.get("/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": jwt_cookie})
    lms_call = next(c for c in calls if c[0] == "lms")
    assert lms_call[2]["cookies"] == {"jwt": jwt_cookie}
    # And the internal token must never be handed to LMS on a teacher's behalf.
    assert "headers" not in lms_call[2] or "X-Internal-Service-Token" not in (lms_call[2].get("headers") or {})


# ── small-cohort suppression happens before PSV is ever queried ─────────────

def test_a_small_classroom_is_suppressed_without_querying_psv(client, monkeypatch):
    """The roster pre-check means per-student state is never even fetched for a
    cohort too small to disclose — suppression is structural, not cosmetic."""
    calls = wire(monkeypatch, roster=roster_of(4))
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": token()}
    )
    assert response.status_code == 200
    assert response.json()["suppressed"] is True
    assert response.json()["concepts"] == []
    assert [c[0] for c in calls] == ["lms"], "PSV must not be reached for a small cohort"


def test_duplicate_roster_entries_do_not_inflate_the_cohort(client, monkeypatch):
    """Six rows naming three students is a cohort of three, not six."""
    roster = FakeResponse(200, {"students": [{"studentId": f"student-{i % 3}"} for i in range(6)]})
    calls = wire(monkeypatch, roster=roster)
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": token()}
    )
    assert response.json()["suppressed"] is True
    assert [c[0] for c in calls] == ["lms"]


def test_a_large_classroom_reaches_psv_with_the_internal_token(client, monkeypatch):
    calls = wire(
        monkeypatch,
        roster=roster_of(6),
        aggregate=FakeResponse(200, {"cohortSize": 6, "concepts": [
            {"conceptId": "fractions", "studentCount": 6, "averageMastery": 0.4,
             "averageGapScore": 0.6, "averageConfidence": 0.7},
        ]}),
    )
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": token()}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["classroomId"] == "class-1"
    assert body["suppressed"] is False
    psv_call = next(c for c in calls if c[0] == "psv")
    assert psv_call[2]["headers"]["X-Internal-Service-Token"] == "internal-token"
    # PSV is scoped to the teacher's own school, not a client-supplied one.
    assert psv_call[2]["json"]["schoolId"] == "school-a"


# ── the aggregate whitelist ─────────────────────────────────────────────────

def test_only_whitelisted_aggregate_keys_are_served(client, monkeypatch):
    wire(monkeypatch, roster=roster_of(6),
         aggregate=FakeResponse(200, {"cohortSize": 6, "concepts": []}))
    for key in ("classroom-mastery", "concept-confusion"):
        assert client.get(
            f"/api/privacy/classrooms/class-1/aggregates/{key}", cookies={"jwt": token()}
        ).status_code == 200
    for key in ("predicted-performance", "disengagement-signals", "raw-answers", "../../etc"):
        assert client.get(
            f"/api/privacy/classrooms/class-1/aggregates/{key}", cookies={"jwt": token()}
        ).status_code == 404


def test_the_aggregate_response_never_carries_evidence_identifiers(client, monkeypatch):
    """A teacher may verify the disclosure gate; raw PSV evidence never crosses it."""
    wire(monkeypatch, roster=roster_of(6), aggregate=FakeResponse(200, {
        "cohortSize": 6,
        "concepts": [{"conceptId": "fractions", "studentCount": 6, "averageMastery": 0.4,
                      "averageGapScore": 0.6, "averageConfidence": 0.7,
                      # Even if PSV leaked these, the guard must drop them.
                      "evidenceIds": ["event-1"], "studentId": "student-1"}],
    }))
    body = client.get(
        "/api/privacy/classrooms/class-1/aggregates/classroom-mastery", cookies={"jwt": token()}
    ).json()

    assert body["provenance"]["evidenceIds"] == []
    assert body["provenance"]["gateVersion"] == main.GATE_VERSION
    assert body["provenance"]["rulesetVersion"] == main.RULESET_VERSION
    serialized = repr(body)
    for leaked in ("evidenceIds\": [\"event-1", "student-1", "rawAnswers"):
        assert leaked not in serialized
    assert "studentId" not in body["data"]["concepts"][0]


# ── upstream failure ────────────────────────────────────────────────────────

def test_an_unreachable_upstream_is_a_503_not_an_empty_aggregate(client, monkeypatch):
    """Failing open here would render an empty class as 'no gaps found'."""
    def exploding_get(url, **kwargs):
        raise httpx.ConnectError("psv down")

    monkeypatch.setattr(main.httpx, "get", exploding_get)
    response = client.get(
        "/api/privacy/classes/class-1/knowledge-gaps", cookies={"jwt": token()}
    )
    assert response.status_code == 503
