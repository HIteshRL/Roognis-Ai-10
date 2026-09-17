"""Shared timezone normalization.

Previously five near-identical copies (`coursework.py`, `stream.py`,
`todo.py`, `gradebook.py`, `terms.py`), each carrying a comment pointing at
the others as the reason it wasn't worth extracting. It became worth
extracting once a correctness fix (the lazy-publish race, `lifecycle.py`)
needed to depend on this logic rather than duplicate it again as a sixth copy.
"""
from __future__ import annotations

from datetime import datetime, timezone


def as_utc(value: datetime) -> datetime:
    # SQLite (tests) drops tzinfo on read-back even for a DateTime(timezone=True)
    # column; Postgres (prod) doesn't. Treat a naive value as UTC either way,
    # matching the frontend's own parseApiDate convention for tz-less ISO strings.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
