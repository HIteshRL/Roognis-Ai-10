from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException

from config import Settings


@dataclass
class SourceResult:
    data: dict[str, Any] | None
    unavailable: str | None = None


class ReportSources:
    def __init__(self, settings: Settings):
        self.settings = settings

    def linked_student_ids(self, parent_id: str, school_id: str) -> list[str]:
        try:
            response = httpx.get(
                f"{self.settings.auth_service_url.rstrip('/')}/api/auth/internal/parents/{parent_id}/students",
                params={"schoolId": school_id},
                headers={"X-Internal-Service-Token": self.settings.internal_service_token},
                timeout=self.settings.upstream_timeout_seconds,
            )
            if response.status_code in {401, 403, 404}:
                raise HTTPException(status_code=403, detail="The parent-child link could not be verified.")
            response.raise_for_status()
            ids = response.json().get("studentIds", [])
            return [item for item in ids if isinstance(item, str)]
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail="Parent links are temporarily unavailable.") from exc

    def _optional_get(self, url: str, *, cookies: dict[str, str] | None = None, headers: dict[str, str] | None = None, params: dict[str, str] | None = None, source: str) -> SourceResult:
        try:
            response = httpx.get(url, cookies=cookies, headers=headers, params=params, timeout=self.settings.upstream_timeout_seconds)
            response.raise_for_status()
            payload = response.json()
            return SourceResult(payload if isinstance(payload, dict) else {})
        except (httpx.HTTPError, ValueError):
            return SourceResult(None, source)

    def analytics_parent_dashboard(self, student_id: str, jwt_cookie: str) -> SourceResult:
        return self._optional_get(
            f"{self.settings.analytics_service_url.rstrip('/')}/api/analytics/parent/dashboard",
            cookies={"jwt": jwt_cookie}, params={"studentId": student_id}, source="analytics",
        )

    def lms_guardian_summary(self, student_id: str, jwt_cookie: str) -> SourceResult:
        return self._optional_get(
            f"{self.settings.lms_service_url.rstrip('/')}/api/lms/guardian/students/{student_id}/summary",
            cookies={"jwt": jwt_cookie}, source="lms",
        )

    def psv_snapshot(self, student_id: str, school_id: str) -> SourceResult:
        # Fail closed at the consumer boundary as well. A stale service URL
        # must not implicitly re-enable an unapproved intervention service.
        if not self.settings.psv_enabled:
            return SourceResult(None, "academic-insights-disabled")
        return self._optional_get(
            f"{self.settings.psv_service_url.rstrip('/')}/api/psv/internal/student-snapshot",
            headers={"X-Internal-Service-Token": self.settings.internal_service_token},
            params={"studentId": student_id, "schoolId": school_id}, source="academic-insights",
        )
