from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from service import _is_reclaimable_refresh_lease


def test_only_expired_running_academic_lease_is_reclaimable():
    now = datetime.now(timezone.utc)
    assert _is_reclaimable_refresh_lease(SimpleNamespace(
        status="running", lease_expires_at=now - timedelta(seconds=1),
    ), now)
    assert not _is_reclaimable_refresh_lease(SimpleNamespace(
        status="running", lease_expires_at=now + timedelta(seconds=1),
    ), now)
    assert not _is_reclaimable_refresh_lease(SimpleNamespace(
        status="done", lease_expires_at=now - timedelta(seconds=1),
    ), now)


def test_sqlite_style_naive_lease_timestamp_is_supported():
    now = datetime.now(timezone.utc)
    assert _is_reclaimable_refresh_lease(SimpleNamespace(
        status="running", lease_expires_at=(now - timedelta(seconds=1)).replace(tzinfo=None),
    ), now)
