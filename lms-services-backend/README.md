# LMS Services Backend

Standalone extraction of the **LMS / Classroom Service** from the
`roognis-product` monorepo (`services/lms/`), taken from that repo's current
on-disk state (uncommitted working tree, not its last commit). Nothing in
the source repo was modified to produce this extraction.

## What this service is

A Google-Classroom-parity teaching layer: classrooms → chapters →
enrollment → coursework (assignment / quiz / question / material) →
submissions → grading, plus the Classroom-parity feature set (stream,
discussions, topics, rubrics, gradebook, calendar, guardians,
notifications, co-teachers, terms, student invitations, uploads, groups,
roster ops) and a **quiz-linking bridge** to a separate Quiz Service.

In the source monorepo's own docs (`CLAUDE.md`), the product's actual
domain — the single-file PWA at `frontend/` — is subjects → chapters →
lessons → quizzes → learning events, and explicitly **not**
classrooms/coursework/gradebook. This LMS service is the secondary,
Classroom-parity surface (paired there with a React app at `web/` under
`/classroom`) — promoted to first-class for classroom-management work as of
that repo's Sprint 0, but still not "the product" by that repo's own
framing. This extraction covers only the FastAPI backend
(`services/lms/`), not the `web/` frontend that talks to it.

- **Stack:** FastAPI + SQLAlchemy 2.0 (Python 3.12) + PyJWT
- **Port:** `3006`
- **Route prefix:** `/api/lms`
- **Database schema:** `lms_db` (on a shared Postgres instance in the
  source monorepo — `postgres:5432/roognis`, schema-per-service; nothing
  about the code requires sharing that instance, it only requires the
  `lms_db` schema to exist in whatever Postgres it's pointed at)
- **Auth:** shared `jwt` httpOnly cookie `{ userId, role, schoolId }`,
  verified with a JWT secret shared with the Auth Service (LMS never issues
  tokens, only verifies them)

## Dependencies

Verified by reading `services/lms`'s actual code (`clients.py`,
`curriculum.py`, `guardians.py`, `main.py`), not assumed from documentation.

### Outbound (LMS calls out to these)

| Service | Env var | Called from | Purpose | Behavior if unset/unreachable |
|---|---|---|---|---|
| Auth Service | `AUTH_SERVICE_URL` | `clients.py` (`lookup_teacher_by_email`, `lookup_student_by_email`), used by `co_teachers.py` and `student_invitations.py` | Resolve an email to a teacher/student in the caller's school via `GET /api/auth/internal/users/by-email`, synchronously — the caller blocks on the result | Raises `AuthServiceUnavailable`; the calling flow (co-teacher invite, student invite) fails explicitly |
| Auth Service | `AUTH_SERVICE_URL` | `guardians.py` | `GET /api/auth/internal/parents/{userId}/students` — resolve a parent's linked students | Same pattern: explicit failure, not silent |
| Auth Service | `AUTH_SERVICE_URL` | `clients.py` (`link_parent_student`), called from `guardians.py`'s `POST /api/lms/guardian/redeem` | `POST /api/auth/internal/link-parent` — upsert the authoritative `auth_db.parentStudent` row when a parent redeems a guardian code, synchronously and before this service's own `Guardian` row flips to `active` | Raises `AuthServiceUnavailable`; the redeem call fails with 503 and the `Guardian` row is left `pending` (never half-linked) |
| Analytics Service | `ANALYTICS_URL` | `clients.py` (`fire_analytics_event`, `fire_analytics_events`) | Fire-and-forget `POST /api/analytics/event` on a daemon thread for `classroom_created`, `student_enrolled`, `coursework_published`, `coursework_submitted`, `coursework_graded`, etc. | Silent no-op — never blocks or fails the caller |
| RAG Service | `RAG_SERVICE_URL` | `curriculum.py` (`fetch_context`) | `GET /api/rag/internal/chapter-context?documentIds=...` to validate a document's chunks before linking it into a `CurriculumVersion` | Raises `HTTPException(503, ...)` — only the curriculum-bridge endpoints need this |
| Quiz Service | `QUIZ_SERVICE_URL` | `clients.py` (`lookup_quiz`), used by `coursework.py`'s `link_quiz` (Sprint 3, T3.1) | `GET /api/quiz/internal/quizzes/{quizId}` to check a quiz exists, is in the caller's school, and is `status == 'ready'` **before** LMS writes `Coursework.quiz_id` | Raises `QuizServiceUnavailable` — only the quiz-linking flow needs this |

All four are read from `services/lms/config.py`'s `Settings` model
(`auth_service_url`, `analytics_url`, `rag_service_url`,
`quiz_service_url`), all default to `""`, and every call site checks for
emptiness before dialing out — so LMS boots and serves its core
classroom/coursework/submission/grading flows with **none** of them set.

Every outbound HTTP call in `clients.py` and `curriculum.py` uses Python's
stdlib `urllib.request`, not an HTTP client library — there is no `httpx`
or `requests` runtime dependency despite `httpx` appearing in
`requirements.txt` (it's there for FastAPI's `TestClient`, used only in
tests).

### Inbound (other services call into LMS)

All gated by `require_internal_token` (`X-Internal-Service-Token` header
checked against `INTERNAL_SERVICE_TOKEN`) — no user JWT involved.

| Route | Consumer | Purpose |
|---|---|---|
| `GET /api/lms/internal/enrollment` | (generic; checks `classroomId` + `studentId` enrollment) | Enrollment check for another service to scope access |
| `GET /api/lms/internal/chapter-access` | AI / RAG services (per the route's own docstring in `main.py`) | Scopes a student's chapter chat to only chapters they're enrolled in and published; returns the chapter's `knowledgeBaseId` |
| `GET /api/lms/internal/quiz-access` | **Quiz Service**, via `services/quiz/lib/lms-quiz-gate.js` (that file lives in `services/quiz`, not copied into this repo — the relationship is documented here, not verified against its source since it's out of scope) | Sprint 3 quiz bridge: gates a student's access to a quiz linked to a coursework item. `linked: false` means the quiz isn't attached to any coursework, so the caller must leave chapter-quiz behavior (the overwhelming majority, opened from the unrelated `frontend/` product surface) untouched |
| `POST /api/lms/internal/quiz-score` | **Quiz Service**, same bridge | Quiz Service posts a graded attempt's score here once `services/quiz/lib/scoring.js` grades it; LMS scales it into `Submission.grade`. No-op (200, `graded: false`) if the quiz isn't linked — never a 4xx for that |
| `GET /api/lms/internal/document-access` | Presumed RAG (same pattern as chapter-access; not independently verified) | `curriculum.py` — checks a student's access to a document via its published `CurriculumVersion` |
| `GET /api/lms/internal/student-documents` | Presumed RAG | `curriculum.py` — lists a student's accessible document ids |
| `POST /api/lms/internal/notifications/batch` | Not identified from `services/lms` code alone (defined in `notifications.py`, consumer not visible from within this service) | Batch-insert notifications | 

**Correction to the task's framing:** the relationship is not purely
"quiz calls into lms." It's bidirectional — Quiz Service calls LMS's
`quiz-access`/`quiz-score` internal routes (as the source repo's
`CLAUDE.md` describes), **but LMS also calls out to the Quiz Service**
(`QUIZ_SERVICE_URL` → `GET /api/quiz/internal/quizzes/{quizId}`) to
validate a quiz before a teacher can link it to coursework. `CLAUDE.md`'s
"quiz bridge" section only documents the quiz→lms direction; the lms→quiz
validation call (`clients.py::lookup_quiz`, used by
`coursework.py::link_quiz`) is real, present in the code, and not
mentioned there.

## Environment variables

From `services/lms/config.py` (the source of truth — a `pydantic-settings`
`Settings` model) cross-referenced against `docker-compose.yml`'s `lms:`
block in the source monorepo. **None of these appear in the source repo's
root `.env.example` or `.env.production.example`** (grepped both directly;
no matches) — they're either hardcoded into `docker-compose.yml`'s `lms`
service or, for the three shared secrets, come from that repo's root
`.env.example`'s generic core-secrets section. This repo's own
`.env.example` documents all of them from scratch.

| Var | Default | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://postgres:postgres@postgres:5432/roognis` | Yes (in practice) | `sqlalchemy_database_url` property rewrites a `postgresql://` URL to `postgresql+psycopg://` |
| `LMS_DB_SCHEMA` | `lms_db` | No | |
| `JWT_SECRET` | `dev-only-lms-secret` | Yes | Must match Auth Service's signing secret |
| `INTERNAL_SERVICE_TOKEN` | `""` | Yes for any internal route or outbound call | |
| `ANALYTICS_URL` | `""` | No | |
| `AUTH_SERVICE_URL` | `""` | No (only for co-teacher/student-invite/guardian flows) | |
| `RAG_SERVICE_URL` | `""` | No (only for curriculum bridge) | |
| `QUIZ_SERVICE_URL` | `""` | No (only for quiz-linking) | See production discrepancy below |
| `LMS_TEST_MODE` | `false` | No | Set by `tests/conftest.py`; disables the background notification sweep task |
| `DB_POOL_SIZE` | `5` | No | |
| `DB_MAX_OVERFLOW` | `5` | No | |
| `FILE_STORAGE_PATH` | `/app/storage` | No | Shared-volume convention with `services/rag`/`services/ai` in the source monorepo; standalone, just needs a writable path |
| `LMS_MAX_UPLOAD_MB` | `20` | No | |
| `LMS_NOTIFICATION_SWEEP_INTERVAL_SECONDS` | `900` | No | Floor of 60s enforced by the field's `ge=60` |

**A real discrepancy worth flagging:** the source monorepo's
`docker-compose.yml` (dev) sets `QUIZ_SERVICE_URL` for the `lms` service,
but `docker-compose.production.yml`'s `lms` block does **not** — its
environment only carries `DATABASE_URL`, `LMS_DB_SCHEMA`, `JWT_SECRET`,
`INTERNAL_SERVICE_TOKEN`, `ANALYTICS_URL`, `RAG_SERVICE_URL`, and
`AUTH_SERVICE_URL`. If that's unintentional upstream, quiz-linking
(`coursework.py::link_quiz`) would fail with `QuizServiceUnavailable` in
that repo's production deployment specifically — worth checking against
that repo directly; not something to silently "fix" here since this is a
read-only extraction.

Also present in the source `docker-compose.yml`'s `lms` block but **not
read by any `Settings` field** in `config.py` (pydantic's `extra="ignore"`
swallows them): `PSV_SERVICE_URL`, `KG_SERVICE_URL`,
`DECISION_SERVICE_URL`, `DISCOVER_SERVICE_URL`, `LMS_SERVICE_URL`. These
look like forward-provisioning for services that source repo's own
`CLAUDE.md` says aren't built yet (`psv`, `decisions`) or that LMS simply
doesn't call (`discover`, and its own URL). Carried into this repo's
`.env.example` as commented-out documentation only.

## Running standalone

```sh
cp .env.example .env
# fill in DB_PASSWORD, JWT_SECRET, INTERNAL_SERVICE_TOKEN at minimum
docker compose up --build
```

This repo's `docker-compose.yml` runs just Postgres + the LMS service,
exposed directly on `http://localhost:3006` (no Traefik — the source
monorepo puts seven other services behind Traefik path-prefix routing,
which isn't meaningful for a single extracted service). Point
`AUTH_SERVICE_URL` / `ANALYTICS_URL` / `RAG_SERVICE_URL` /
`QUIZ_SERVICE_URL` at real deployments of those services, or leave them
unset to run LMS's core classroom/coursework/grading flows in isolation
(see the Dependencies table above for exactly what degrades).

Without Docker:

```sh
cd services/lms
pip install -r requirements.txt
python main.py   # serves on :3006, or $PORT
```

Schema migrations are managed with Alembic (`services/lms/alembic/`,
20 versioned migrations as of this resync — `0019_submission_is_late` adds
`Submission.is_late`, `0020_guardian_redeemable_code` adds `Guardian.token`'s
unique index and `Guardian.code_expires_at`) — the source monorepo's dev
Compose flow doesn't auto-run them for this service the way Prisma
`db push` does for the Node services; run `alembic upgrade head` from
`services/lms` against your target database before first boot.

## Tests

```sh
cd services/lms
pip install -r requirements.txt
pytest -q
```

Verified two things the task asked to confirm, both accurate:

1. **`pytest.ini` exists** at `services/lms/pytest.ini` and pins
   `testpaths = tests`. Its own top comment explains why: `conftest.py`
   does a bare `from database import Base`, which only resolves when
   `services/lms` itself is the working directory / rootdir — so tests
   must be run as `cd services/lms && pytest -q`, not
   `pytest services/lms/tests` from a repo root. In this standalone repo
   that's simply "run `pytest -q` from `services/lms`", since the whole
   repo's root already sits one level up from the monorepo's equivalent
   path.
2. **Tests run against in-memory SQLite**, not Postgres —
   `tests/conftest.py` sets this up independently of whatever
   `DATABASE_URL` is configured, and sets `lms_test_mode = true`, which
   `main.py`'s lifespan handler checks to skip starting the background
   notification-sweep asyncio task during tests.

## What was intentionally left out

- `services/quiz/lib/lms-quiz-gate.js` — lives in the Quiz Service, not
  LMS. Documented above as the inbound-caller relationship, not copied
  (out of scope: this extraction is LMS only).
- The `web/` React frontend that actually talks to this API in the source
  monorepo. This extraction is backend-only.
- Build artifacts (`__pycache__/`, `.pytest_cache/`) present in the source
  working tree were not copied — regenerated automatically on first
  `pytest`/`python` run.

## Source

Extracted from `services/lms/` in the `roognis-product` monorepo's
**current on-disk working tree** (which carries substantial uncommitted
changes beyond its last commit, `ce08c39 Import engineer LMS foundation`)
— not from a tagged release or clean commit. The source repo was not
modified by this extraction.

**Resynced 2026-09-17** against the monorepo's then-current state (commit
`6b1d421 Cleanup: Remove disconnected and orphaned code`) to pick up
`clients.py`, `coursework.py`, `guardians.py`, `models.py`, two new Alembic
migrations, and the corresponding test files — see the Dependencies table
above and the migration count below for what changed. The source repo was
again not modified.
