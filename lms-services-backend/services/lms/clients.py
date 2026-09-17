"""Outbound calls to sibling services.

Analytics events (`fire_analytics_event`) are emitted on a daemon thread so a
slow or unavailable Analytics Service never blocks or fails a teacher/student
request — the same non-blocking contract the Node services use for
`fireAnalyticsEvent`. `lookup_teacher_by_email` / `lookup_student_by_email`
are the synchronous exception: their caller needs the result to decide
whether a request succeeds, so they block (with a short timeout) and raise
on failure instead of swallowing it.
"""
import json
import logging
import threading
from urllib import request as urlrequest
from urllib.error import URLError
from urllib.parse import quote

from config import Settings

logger = logging.getLogger(__name__)


class AuthServiceUnavailable(Exception):
    """Raised when the Auth Service can't be reached for a synchronous lookup."""


class QuizServiceUnavailable(Exception):
    """Raised when the Quiz Service can't be reached for a synchronous lookup."""


def fire_analytics_event(settings: Settings, event: dict) -> None:
    if not settings.analytics_url or not settings.internal_service_token:
        return

    endpoint = f"{settings.analytics_url.rstrip('/')}/api/analytics/event"
    token = settings.internal_service_token

    def _send() -> None:
        try:
            body = json.dumps(event).encode("utf-8")
            req = urlrequest.Request(
                endpoint,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Service-Token": token,
                },
            )
            with urlrequest.urlopen(req, timeout=3) as response:
                if response.status >= 300:
                    logger.warning("analytics event returned status %s", response.status)
        except (OSError, URLError, ValueError) as exc:
            logger.warning("analytics event failed: %s", exc)

    threading.Thread(target=_send, daemon=True).start()


def fire_analytics_events(settings: Settings, events: list[dict]) -> None:
    """Sprint 4, P3: like `fire_analytics_event`, but one daemon thread for
    the whole list instead of one per event — a 100-row bulk grade
    previously spawned 100 OS threads for this alone. Deliberately still
    posts one HTTP request per event (not a batched endpoint): Analytics'
    `KNOWN_EVENT_TYPES` gate and its per-event shape are unchanged, and a
    dashboard counting `coursework_graded` must see the same event count as
    before — only the thread count drops, not the event count."""
    if not settings.analytics_url or not settings.internal_service_token or not events:
        return

    endpoint = f"{settings.analytics_url.rstrip('/')}/api/analytics/event"
    token = settings.internal_service_token

    def _send_all() -> None:
        for event in events:
            try:
                body = json.dumps(event).encode("utf-8")
                req = urlrequest.Request(
                    endpoint,
                    data=body,
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "X-Internal-Service-Token": token,
                    },
                )
                with urlrequest.urlopen(req, timeout=3) as response:
                    if response.status >= 300:
                        logger.warning("analytics event returned status %s", response.status)
            except (OSError, URLError, ValueError) as exc:
                logger.warning("analytics event failed: %s", exc)

    threading.Thread(target=_send_all, daemon=True).start()


def _lookup_user_by_email(settings: Settings, email: str, school_id: str, role: str) -> dict | None:
    """Resolve an email to a user of `role` in the given school, via the Auth
    Service's internal endpoint. Returns None if no such user exists; raises
    AuthServiceUnavailable if the Auth Service can't be reached at all
    (distinct from "not found" — the caller should surface these differently)."""
    if not settings.auth_service_url or not settings.internal_service_token:
        raise AuthServiceUnavailable("Auth Service lookup is not configured.")

    url = (
        f"{settings.auth_service_url.rstrip('/')}/api/auth/internal/users/by-email"
        f"?email={quote(email)}&schoolId={quote(school_id)}&role={quote(role)}"
    )
    req = urlrequest.Request(
        url,
        method="GET",
        headers={"X-Internal-Service-Token": settings.internal_service_token},
    )
    try:
        with urlrequest.urlopen(req, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except urlrequest.HTTPError as exc:
        if exc.code == 404:
            return None
        raise AuthServiceUnavailable(f"Auth Service returned {exc.code}") from exc
    except (OSError, URLError, ValueError) as exc:
        raise AuthServiceUnavailable(str(exc)) from exc


def lookup_teacher_by_email(settings: Settings, email: str, school_id: str) -> dict | None:
    return _lookup_user_by_email(settings, email, school_id, "teacher")


def lookup_student_by_email(settings: Settings, email: str, school_id: str) -> dict | None:
    return _lookup_user_by_email(settings, email, school_id, "student")


def link_parent_student(settings: Settings, parent_id: str, student_id: str, school_id: str) -> None:
    """Establish the *authoritative* parent↔student link in the Auth Service
    (``auth_db.parentStudent``) — the table that actually populates a
    parent's JWT ``studentIds`` at login, and what
    ``guardians.py::linked_student_ids`` checks live against today.

    Calls ``POST /api/auth/internal/link-parent`` — an internal-token-gated
    sibling of the pre-existing, teacher-JWT-gated ``POST /api/auth/link-parent``
    (``services/auth/routes/auth.routes.js``). That route requires
    ``requireRole('teacher')``, and the guardian-code redeemer here is a
    *parent*, not a teacher, so the existing route cannot be called on the
    parent's behalf. The new internal route does the identical upsert, just
    authenticated the way every other cross-service call in this file is.

    Synchronous, and raises `AuthServiceUnavailable` on any failure — the
    caller (``guardians.py::redeem_guardian_code``) must not mark its own
    row ``active`` unless this succeeds, or the LMS and the Auth Service
    would disagree about whether the guardian link is real."""
    if not settings.auth_service_url or not settings.internal_service_token:
        raise AuthServiceUnavailable("Auth Service link is not configured.")

    url = f"{settings.auth_service_url.rstrip('/')}/api/auth/internal/link-parent"
    body = json.dumps({"parentId": parent_id, "studentId": student_id, "schoolId": school_id}).encode("utf-8")
    req = urlrequest.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Internal-Service-Token": settings.internal_service_token,
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=5):
            return
    except urlrequest.HTTPError as exc:
        raise AuthServiceUnavailable(f"Auth Service returned {exc.code}") from exc
    except (OSError, URLError, ValueError) as exc:
        raise AuthServiceUnavailable(str(exc)) from exc


def lookup_quiz(settings: Settings, quiz_id: str) -> dict | None:
    """Sprint 3, T3.1: fetch a quiz's `{id, schoolId, status, questionCount,
    title}` from the Quiz Service, for validating a link before it's
    written (decision D10 — the caller checks `status == 'ready'` and
    `schoolId` itself; this function only fetches). Returns None if no
    such quiz exists; raises QuizServiceUnavailable if the Quiz Service
    can't be reached at all — the caller must not treat that as "not
    found", the same distinction the Auth Service lookups above make."""
    if not settings.quiz_service_url or not settings.internal_service_token:
        raise QuizServiceUnavailable("Quiz Service lookup is not configured.")

    url = f"{settings.quiz_service_url.rstrip('/')}/api/quiz/internal/quizzes/{quote(quiz_id)}"
    req = urlrequest.Request(
        url,
        method="GET",
        headers={"X-Internal-Service-Token": settings.internal_service_token},
    )
    try:
        with urlrequest.urlopen(req, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except urlrequest.HTTPError as exc:
        if exc.code == 404:
            return None
        raise QuizServiceUnavailable(f"Quiz Service returned {exc.code}") from exc
    except (OSError, URLError, ValueError) as exc:
        raise QuizServiceUnavailable(str(exc)) from exc
