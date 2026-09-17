from config import Settings
from sources import ReportSources


def test_psv_is_disabled_by_default_without_an_outbound_request(monkeypatch):
    def unexpected_get(*_args, **_kwargs):
        raise AssertionError("Reporting must not call PSV when PSV is disabled")

    monkeypatch.setattr("sources.httpx.get", unexpected_get)
    result = ReportSources(Settings(psv_enabled=False)).psv_snapshot("student-1", "school-1")
    assert result.data is None
    assert result.unavailable == "academic-insights-disabled"
