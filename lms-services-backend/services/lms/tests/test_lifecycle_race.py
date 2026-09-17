"""Regression test for the lazy-publish claim race (plan Phase 2.1).

The test suite's `TestClient` + in-memory-SQLite setup runs single-threaded,
so it cannot reproduce two HTTP requests actually overlapping in time. But
`database.py`'s SQLite engine uses `StaticPool` — every `SessionLocal()`
instance shares the same one physical connection — so two independent ORM
sessions can be driven by hand, sequentially, to reproduce exactly the state
two concurrent requests would each observe: both load the same due-scheduled
row *before* either one has flipped it. That reproduces the race precisely
enough to prove the claim logic itself (the conditional `UPDATE ... WHERE
status = 'scheduled'`, checked by `rowcount`) rather than the read-then-write
that used to run unconditionally.
"""
from datetime import datetime, timedelta, timezone

import lifecycle
from database import SessionLocal
from models import Announcement, Classroom, Coursework


def cookie(token):
    return {"jwt": token}


def test_two_racing_readers_of_due_coursework_only_one_claims_and_notifies(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Race Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Scheduled HW", "scheduledFor": past},
        cookies=cookie(teacher),
    ).json()
    assert coursework["status"] == "scheduled"

    db_a = SessionLocal()
    db_b = SessionLocal()
    try:
        # Both "requests" read the row before either has processed it — the
        # exact interleaving that produced the double-notify bug.
        item_a = db_a.get(Coursework, coursework["id"])
        item_b = db_b.get(Coursework, coursework["id"])
        assert item_a.status == "scheduled"
        assert item_b.status == "scheduled"

        now = datetime.now(timezone.utc)
        notified_a: list[str] = []
        notified_b: list[str] = []

        lifecycle.publish_due_scheduled(
            db_a,
            Coursework,
            scheduled_value="scheduled",
            published_value="published",
            items=[item_a],
            now=now,
            notify_one=lambda c: notified_a.append(c.id),
        )
        # db_b's copy is still stale ('scheduled') in Python, exactly as a
        # second request's freshly-loaded row would be — but the claim runs
        # as a conditional UPDATE against the database's current state, not
        # against this stale in-memory object.
        lifecycle.publish_due_scheduled(
            db_b,
            Coursework,
            scheduled_value="scheduled",
            published_value="published",
            items=[item_b],
            now=now,
            notify_one=lambda c: notified_b.append(c.id),
        )

        assert notified_a == [coursework["id"]], "the first claimant must notify exactly once"
        assert notified_b == [], "the loser of the race must not notify a second time"

        # Both objects are refreshed regardless of who won, so a response
        # built from either session reflects reality rather than a stale
        # 'scheduled' status.
        assert item_a.status == "published"
        assert item_b.status == "published"
    finally:
        db_a.close()
        db_b.close()


def test_two_racing_readers_of_due_announcement_only_one_claims_and_notifies(client, token_factory):
    """Same race, same fix, the Announcement copy in stream.py."""
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Race Stream", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    post = client.post(
        f"/api/lms/classrooms/{classroom['id']}/announcements",
        json={"body": "Heads up", "status": "scheduled", "scheduledFor": past},
        cookies=cookie(teacher),
    ).json()
    assert post["status"] == "scheduled"

    db_a = SessionLocal()
    db_b = SessionLocal()
    try:
        item_a = db_a.get(Announcement, post["id"])
        item_b = db_b.get(Announcement, post["id"])
        assert item_a.status == "scheduled"
        assert item_b.status == "scheduled"

        now = datetime.now(timezone.utc)
        notified_a: list[str] = []
        notified_b: list[str] = []

        lifecycle.publish_due_scheduled(
            db_a,
            Announcement,
            scheduled_value="scheduled",
            published_value="published",
            items=[item_a],
            now=now,
            notify_one=lambda a: notified_a.append(a.id),
        )
        lifecycle.publish_due_scheduled(
            db_b,
            Announcement,
            scheduled_value="scheduled",
            published_value="published",
            items=[item_b],
            now=now,
            notify_one=lambda a: notified_b.append(a.id),
        )

        assert notified_a == [post["id"]]
        assert notified_b == []
        assert item_a.status == "published"
        assert item_b.status == "published"
    finally:
        db_a.close()
        db_b.close()


def test_a_row_not_yet_due_is_left_untouched(client, token_factory):
    """Guards against the claim loop firing on every scheduled row instead of
    only the ones whose time has actually passed."""
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Future Class", "subject": "Science"}, cookies=cookie(teacher)
    ).json()
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "Not due yet", "scheduledFor": future},
        cookies=cookie(teacher),
    ).json()

    db = SessionLocal()
    try:
        item = db.get(Coursework, coursework["id"])
        notified: list[str] = []
        lifecycle.publish_due_scheduled(
            db,
            Coursework,
            scheduled_value="scheduled",
            published_value="published",
            items=[item],
            now=datetime.now(timezone.utc),
            notify_one=lambda c: notified.append(c.id),
        )
        assert notified == []
        assert item.status == "scheduled"
    finally:
        db.close()
