"""Sprint 1, T4.1 / frozen contract C3: the notification-type vocabulary.

One constant per string literal actually emitted somewhere in this service —
confirmed by grepping every `notify.emit`/`notify.emit_many` call site before
writing this file. No placeholder types for triggers that don't exist yet
(e.g. a guardian-invite notification, or a due-date scheduler) — those would
be dead code until something actually fires them.
"""
from __future__ import annotations

NEW_ANNOUNCEMENT = "new_announcement"
MENTION = "mention"
REPLY = "reply"
COURSEWORK_PUBLISHED = "coursework_published"
COURSEWORK_RETURNED = "coursework_returned"
# Sprint 2, P3: a private teacher<->student comment on a submission.
PRIVATE_COMMENT = "private_comment"
# Sprint 2, P4: emitted from GET /student/todo's own read (todo.py), not a
# scheduler — see that module for the accepted "only fires if the student
# looks" tradeoff this implies.
DUE_SOON = "due_soon"
OVERDUE = "overdue"
