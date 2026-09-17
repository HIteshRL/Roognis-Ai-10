# Intelligence & Decisioning services — extracted from roognis-product

## 🚫 `services/psv` is NOT approved for production deployment

`services/psv/campaigns.py` implements an undocumented "retention campaign"
system that calls `POST /api/lms/internal/notifications/batch` on the LMS
service (`lms-services-backend`) to push notifications to students/parents.
This surfaced by tracing an unexplained endpoint during a pre-launch cleanup
pass — it was **not** requested by anyone and has no product/design sign-off.

**Do not wire `services/psv` (or the `campaigns.py` module specifically) up
to any environment, staging or production, until a founder has reviewed and
explicitly approved it.** The LMS-side endpoint it calls is token-gated and
fails closed if nothing calls it, so leaving it dormant costs nothing;
shipping an unreviewed internal surface with no docs, days before a
production launch, is itself a risk. See the "Flag: doc-vs-code
discrepancy" section below for the fuller trace of how `psv` came to exist
on disk at all.

This repo is a **read-only extraction** of five Python/FastAPI services out of the
`roognis-product` monorepo, taken from the monorepo's **current on-disk working
tree** (249 uncommitted changes on top of commit `ce08c39`, as of 2026-09-16) —
not from the last commit. Nothing in the source repo was modified to produce this
extraction.

Copied verbatim, one subfolder per service:

```
services/
  kg/         Knowledge Graph service
  decisions/  Decision (policy/blending) service
  psv/        Preference/State/Value store — the academic learner-state engine
  privacy/    Privacy Guard — teacher-facing aggregate gate
  gnn/        Graph Neural Network inference + training worker (serves 4 compose entries)
```

`__pycache__`, `.pytest_cache`, and `*.pyc` were excluded as build artifacts.
Everything else — including test suites, Dockerfiles, and a few odd dangling
symlinks described below — was copied as-is.

## ⚠️ Flag: doc-vs-code discrepancy (Layer 0 / psv / decisions)

The source repo's own `CLAUDE.md` states:

> Build order is strict (Layers 0–6). Layer 0 — freezing the event/PSV/KG/evidence
> contracts — is not complete, so `services/psv` and `services/decisions` are
> explicitly **not to be written yet**.

But `services/psv` and `services/decisions` (along with `kg`, `privacy`, and `gnn`)
**already exist on disk**, are non-trivial (psv alone has 9 test files covering
provenance, prerequisites, scoring, campaigns, refresh leases, and a trust
boundary), and are wired into `docker-compose.yml` with real inter-service
dependencies (`psv` depends_on `kg`, `decisions`, `knowledge-gnn`,
`knowledge-gnn-trainer`, `postgres`).

Per the source repo's own conflict-resolution rule ("actual code and migrations
win"), this extraction copied what is actually on disk. **This is flagged for the
user to resolve, not a decision this extraction makes.** Two read facts worth
weighing when you do:

- None of `kg`, `decisions`, `psv`, `privacy`, `gnn`/`preference-gnn`/
  `knowledge-gnn`/`*-trainer`, or `neo4j` appear anywhere in
  `docker-compose.production.yml` — they exist only in the dev compose file.
  Whatever wrote this code did not (yet) ship it to production.
- `kg` and `decisions` have **no Traefik labels** in `docker-compose.yml` (unlike
  `psv` and `privacy`, which both have `PathPrefix` routes) — they are reachable
  only container-to-container on the compose network, not through Traefik at all.
- The `web/` frontend's own client-side capability registry
  (`Ul` object in `web/dist/assets/index-*.js`, keys `privacy.class-aggregates`,
  `decisions.intervention-queue`, `decisions.recommendations`) marks all
  privacy/decisions-backed teacher features `reason: "blocked"` — i.e. the one
  frontend that could call these services deliberately treats them as not-yet-usable
  and shows a "Gated by the build sequence" notice instead of calling them.

So: the code exists and is tested, but nothing currently deployed calls it in
production, and the one UI that could call two of these services knowingly
doesn't yet. Whether that means "Layer 0 is further along than HANDOFF.md says"
or "someone built ahead of the documented sequence" is for the user to decide.

## What each service actually does (verified from code, not the name)

### `services/kg` — Knowledge Graph service
- **Stack**: FastAPI + `neo4j` Python driver (`neo4j==5.28.1`), `PyJWT`,
  `pydantic-settings`. Pure Python, no ORM.
- **Port**: `3012`. **No Traefik route** — internal-network-only in
  `docker-compose.yml` (confirmed: no `traefik.http.routers.kg.*` labels exist).
- **What it does**: a thin CRUD/query layer over a Neo4j graph. Routes
  (`services/kg/main.py`): `PUT /api/kg/v1/nodes/{id}` (upsert a node),
  `GET /api/kg/v1/nodes/{id}`, `POST /api/kg/v1/relationships` (link two nodes),
  `POST /api/kg/internal/subgraph` (load a subgraph by node ids). Every route
  except `/health` is gated by `require_internal_token`
  (`INTERNAL_SERVICE_TOKEN`) — there is no student/teacher JWT auth path at all.
- **Storage**: `Neo4jGraphRepository` (`services/kg/repository.py`) talks to
  Neo4j via `bolt://`. A `KG_TEST_MODE=true` env flag swaps in an in-memory
  `MemoryGraphRepository` with an identical wire contract (used by
  `docker-compose.yml`'s healthcheck-friendly dev default is `'false'` — i.e. the
  compose file runs it against real Neo4j, not the memory stub).
- **Depends on**: **Neo4j** (external graph database — see "External
  infrastructure" below). Not copied into this repo; you must run your own.

### `services/decisions` — Decision service
- **Stack**: FastAPI, `pydantic-settings`. No database, no persistence, no
  outbound HTTP calls to anything — genuinely stateless.
- **Port**: `3014`. **No Traefik route** — internal-only.
- **What it does**: pure-function policy/blending logic
  (`services/decisions/policy.py`), gated by `require_internal_token`. Two
  endpoints: `POST /api/decisions/v1/preference` and
  `POST /api/decisions/v1/knowledge`. Both take a baseline value plus an
  optional GNN-model value/confidence and return a blended result — blend
  weight is `min(gnn_max_blend_weight, confidence)`, only applied when
  `confidence >= gnn_min_confidence` (defaults 0.6 / 0.55). A `hard_stance`
  (`MUTE`/`LIKE`/`DISLIKE`) always overrides the blend. Knowledge decisions also
  bound next-difficulty movement to one step (`_bounded_difficulty`). This is the
  literal implementation of `MASTERCONTEXT.md`'s "no LLM calls in
  scoring/routing/difficulty" rule — it's arithmetic, not a model call.
- **Depends on**: nothing externally. Purely takes signals from its caller.

### `services/psv` — the learner-state engine (Preference/State/Value store)
- **Stack**: FastAPI + SQLAlchemy 2.0 + `psycopg[binary]` (Postgres), `PyJWT`,
  `httpx`.
- **Port**: `3011`. **Has a Traefik route**:
  `PathPrefix('/api/psv')`, entrypoint `web`.
- **Database**: shared Postgres instance (`postgresql://...@postgres:5432/roognis`),
  schema `psv_db` (`PSV_DB_SCHEMA`). This is the monorepo's single shared
  Postgres — not copied into this repo (see "External infrastructure").
- **What it does** (`services/psv/main.py`, `service.py`, `scoring.py`,
  `campaigns.py`): ingests per-student learning events
  (`POST /api/psv/v1/events/batch` student route,
  `POST /api/psv/internal/events/batch` internal/trusted route), computes
  per-concept mastery/readiness/gap-score snapshots and spaced-repetition
  retention state (`RetentionState`: predicted recall now/24h/7d, half-life),
  and runs a daily refresh loop plus a real-time "intervention campaign"
  projection loop. Student-facing reads:
  `GET /api/psv/v1/me/retention`, `GET /api/psv/v1/me/knowledge-gaps`,
  `DELETE /api/psv/v1/me` (erase — a real right-to-erasure endpoint). Internal
  reads: `GET /api/psv/internal/student-snapshot` (single student, **with**
  provenance — event ids + gate version), `POST
  /api/psv/internal/knowledge-gaps/aggregate` (cohort aggregate, **no**
  provenance — this is what `services/privacy` is allowed to call), plus
  `/api/psv/internal/recompute`, `/api/psv/internal/events/count`, and an
  observability endpoint `/api/psv/internal/immediate-path/stats` that measures
  campaign-creation latency against a 60s SLO.
- **Outbound calls it makes** (verified in `gnn_client.py`, `decision_client.py`,
  `training_client.py`, `campaigns.py`):
  - `KG_SERVICE_URL` → `POST /api/kg/internal/subgraph` (loads the concept's
    prerequisite subgraph before scoring)
  - `GNN_SERVICE_URL` (`knowledge-gnn`) → `POST /internal/gnn/v1/knowledge/score`
  - `GNN_TRAINER_URL` (`knowledge-gnn-trainer`) → `POST /internal/gnn/v1/train`
  - `DECISION_SERVICE_URL` → `POST /api/decisions/v1/knowledge`
  - `LMS_SERVICE_URL` → `POST /api/lms/internal/notifications/batch`
    (`campaigns.py`, fire-and-forget intervention notifications)
  - Every one of these fails open to a local baseline/fallback on error — psv
    never blocks on any of them.
  - **Declared but unused**: `docker-compose.yml` also sets `PSV_SERVICE_URL`,
    `DISCOVER_SERVICE_URL`, and `QUIZ_SERVICE_URL` as env vars on the `psv`
    container, but `services/psv/config.py` does not read any of the three
    (`pydantic-settings` with `extra="ignore"` silently drops them) — dead
    wiring, psv does not actually call discover or quiz.

### `services/privacy` — Privacy Guard (teacher-facing aggregate gate)
- **Stack**: FastAPI, `PyJWT`, `httpx`. No database.
- **Port**: `3015`. **Has a Traefik route**: `PathPrefix('/api/privacy')`.
- **What it does** (`services/privacy/main.py`): the *only* documented legal
  path for a teacher to see anything mastery/knowledge-gap-derived about their
  students, per `CLAUDE.md`'s "no teacher/parent view over learner-derived data
  before `services/privacy` exists" rule. Two teacher-JWT-gated routes:
  `GET /api/privacy/classes/{classroomId}/knowledge-gaps` and
  `GET /api/privacy/classrooms/{classroomId}/aggregates/{aggregateKey}`
  (`aggregateKey` restricted to `classroom-mastery` / `concept-confusion`).
  Both: fetch the classroom roster from LMS, call psv's aggregate endpoint with
  the student-id list, then run `privacy_filter_aggregate`
  (`services/privacy/policy.py`) which suppresses any concept row where cohort
  size is below `PRIVACY_MIN_COHORT_SIZE` (default 5) — k-anonymity by
  cohort-size floor. Raw per-student evidence ids never cross this boundary
  (`evidenceIds: []` is hardcoded in the response, with a comment saying why).
- **Outbound calls it makes**: `LMS_SERVICE_URL` → `GET
  /api/lms/classrooms/{id}/students` (roster, forwarding the teacher's own JWT
  cookie); `PSV_SERVICE_URL` → `POST
  /api/psv/internal/knowledge-gaps/aggregate` (internal token).
  **Declared but unused**: compose also sets `KG_SERVICE_URL`,
  `DECISION_SERVICE_URL`, `DISCOVER_SERVICE_URL`, `QUIZ_SERVICE_URL` on the
  `privacy` container; `services/privacy/config.py` reads none of them — same
  dead-wiring pattern as psv.

### `services/gnn` — GNN inference + training, one directory serving 4 compose services
There is **no separate subfolder per lane** — `docker-compose.yml` builds the
*same* `./services/gnn` directory four times, distinguished purely by env vars
and command overrides:

| Compose service | Command | Port | `GNN_LANE` | Model artifact volume |
|---|---|---|---|---|
| `preference-gnn` | default (`main:app`) | 3013 | `preference` | `preference_model_artifacts:/models/preference:ro` |
| `preference-gnn-trainer` | `uvicorn trainer_main:app --port 3016` | 3016 | `preference` | `preference_model_artifacts:/models/preference` (read-write) |
| `knowledge-gnn` | default (`main:app`) | 3013 | `knowledge` | `knowledge_model_artifacts:/models/knowledge:ro` |
| `knowledge-gnn-trainer` | `uvicorn trainer_main:app --port 3016` | 3016 | `knowledge` | `knowledge_model_artifacts:/models/knowledge` (read-write) |

None of the four have a Traefik route — all internal-only, reached by other
services via their compose DNS names (`http://knowledge-gnn:3013`, etc.).

- **Stack**: FastAPI, `numpy` (the actual graph-neural-net math — see
  `graph_models.py`: `PreferenceSignedGNN`, `KnowledgeGraphTemporalNetwork`),
  `httpx`, `pydantic-settings`. No database — models are JSON artifacts on a
  shared Docker volume, hot-reloaded by mtime (`current_models()` in
  `main.py` re-stats the artifact file on every request without restarting).
- **Inference side** (`main.py`, `graph_models.py`, `artifacts.py`):
  `POST /internal/gnn/v1/preference/score` or `.../knowledge/score`, each
  internal-token-gated and lane-checked (a preference-lane deployment 409s a
  knowledge-score request). Returns `eligible: false` with a named `reason`
  (`shadow_mode`, `unpromoted_model`, `stale_model`, `insufficient_coverage`,
  `low_confidence`) rather than a low-confidence score whenever the artifact
  isn't trustworthy yet — `GNN_SHADOW_MODE=true` in the current compose config
  means **both preference-gnn and knowledge-gnn currently always return
  `eligible: false`** by design (shadow-mode = compute and log, never let a
  downstream decision actually use it). This is why `decisions/policy.py`'s
  GNN-blend branch is presently dead in practice — every caller sees
  `gnn_eligible: false`.
  Staleness is 72h (`gnn_max_model_age_hours`); coverage floors are 3
  (preference) / 5 (knowledge) distinct signed evidence items.
- **Training side** (`trainer_main.py`, `pretrain.py`, `promote.py`,
  `rollback.py`): `POST /internal/gnn/v1/train` takes up to 5000 training
  samples, uses an `fcntl` file lock on the artifact path so concurrent
  training runs (or replicas) can't race, and calls `pretrain_and_promote`
  which presumably runs a held-out evaluation before atomically swapping the
  artifact (see `promote.py`/`rollback.py` for the promotion gate — not
  re-derived here beyond what the route wiring shows).
- **Model artifacts shipped in this copy**:
  `services/gnn/model-artifacts/preference/model.json` and
  `.../knowledge/model.json` — these are the actual bootstrap/current artifact
  files copied from disk, not regenerated.
- **Depends on**: nothing externally at inference time (pure local compute over
  the request payload + on-disk artifact). The trainer needs nothing beyond a
  writable shared volume for the artifact.

## Dependency map (verified from code)

**Outbound — what these 5 services call:**

| From | Calls | Verified in |
|---|---|---|
| `psv` | `kg` (`POST /api/kg/internal/subgraph`) | `services/psv/gnn_client.py` |
| `psv` | `knowledge-gnn` (`POST /internal/gnn/v1/knowledge/score`) | `services/psv/gnn_client.py` |
| `psv` | `knowledge-gnn-trainer` (`POST /internal/gnn/v1/train`) | `services/psv/training_client.py` |
| `psv` | `decisions` (`POST /api/decisions/v1/knowledge`) | `services/psv/decision_client.py` |
| `psv` | `lms` (`POST /api/lms/internal/notifications/batch`) | `services/psv/campaigns.py` |
| `privacy` | `lms` (`GET /api/lms/classrooms/{id}/students`) | `services/privacy/main.py` |
| `privacy` | `psv` (`POST /api/psv/internal/knowledge-gaps/aggregate`) | `services/privacy/main.py` |
| `kg` | Neo4j only | `services/kg/repository.py` |
| `decisions` | nothing (stateless) | `services/decisions/main.py` |
| `gnn` (inference) | nothing (local artifact + request payload only) | `services/gnn/main.py` |
| `gnn` (trainer) | nothing (writes local/shared-volume artifact) | `services/gnn/trainer_main.py` |

**Inbound — what calls these 5 services, verified against the calling
services' code (all present in the same monorepo checkout, so independently
verifiable — none of this is taken on the strength of `CLAUDE.md`'s claims
alone):**

| Caller | Calls | Verified in |
|---|---|---|
| `services/ai` | `psv` (`GET /api/psv/internal/student-snapshot`) | `services/ai/knowledge-gap-context.js`, `services/ai/server.js` |
| `services/quiz` | `kg` (writes concept/assessment/misconception nodes + relationships) | `services/quiz/server.js` (`KG_SERVICE_URL`, `/api/kg/v1/nodes/...`, `/api/kg/v1/relationships`) |
| `services/quiz` | `psv` (`POST /api/psv/internal/events/batch`, fire-and-forget) | `services/quiz/evidence-outbox.js` |
| `services/practice` | `psv` (student-snapshot + events/batch) | `services/practice/academic-support.js`, `services/practice/evidence-outbox.js` |
| `services/discover` | `preference-gnn` (`POST /internal/gnn/v1/preference/score`) | `services/discover/preference/refresh.js` |
| `services/discover` | `preference-gnn-trainer` (`POST /internal/gnn/v1/train`) | `services/discover/preference/refresh.js` |
| `services/discover` | `decisions` (`POST /api/decisions/v1/preference`) | `services/discover/preference/refresh.js` |
| `services/rag` | `kg` (curriculum topology — writes nodes/relationships) | `services/rag/curriculum_publish.py` |
| `services/reporting` | `psv` (`GET /api/psv/internal/student-snapshot`) | `services/reporting/sources.py` |
| `web/` (frontend) | **NOT wired** — `privacy` and `decisions` appear only as entries in a client-side capability registry marked `reason: "blocked"` (shows a "gated by the build sequence" notice instead of calling the API) | `web/dist/assets/index-*.js` (capability keys `privacy.class-aggregates`, `decisions.intervention-queue`, `decisions.recommendations`) |

This independently confirms the three relationships the source `CLAUDE.md`/task
description named (discover→decisions, quiz→kg/psv, ai→psv) — all verified
directly against the calling services' code, not taken on trust from docs.
None of these calling services (`ai`, `quiz`, `discover`, `practice`, `rag`,
`reporting`) are part of this extraction — they stay in the monorepo. This repo
is the 5 intelligence/decisioning services only; wiring it up standalone means
either stubbing those callers or running this alongside the rest of
`roognis-product`.

## External infrastructure this extraction depends on but does not include

- **Neo4j** — required by `kg` only. `docker-compose.yml`'s `neo4j` service uses
  image `neo4j:5.26-community`, exposed to `kg` at `bolt://neo4j:7687` with
  `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`. Not copied here (it's a stock
  image, not app code) — run your own and point `kg` at it, or set
  `KG_TEST_MODE=true` to use `kg`'s built-in in-memory repository stub instead
  (same wire contract, no persistence, fine for local dev/testing only).
- **PostgreSQL** — required by `psv` only, for the `psv_db` schema on the
  monorepo's single shared `roognis` database
  (`postgresql://postgres:${DB_PASSWORD}@postgres:5432/roognis`). `kg`,
  `decisions`, `privacy`, and `gnn` need no database at all.
- **`services/lms`** (not part of this extraction) — `psv` and `privacy` both
  call it (roster, notifications). Without it reachable, `privacy`'s routes
  503 (`httpx.HTTPError` → `503 Knowledge-gap aggregate is temporarily
  unavailable`), and `psv`'s campaign-notification calls fail silently
  (fire-and-forget).

## Required environment variables (from `docker-compose.yml`)

| Variable | Used by | Notes |
|---|---|---|
| `NEO4J_PASSWORD` | `kg` (+ the neo4j container itself) | required, no default (`:?set ... in .env`) |
| `INTERNAL_SERVICE_TOKEN` | all 5 services | required; gates every non-`/health` route on `kg`/`decisions`/`gnn`; gates internal routes on `psv`/`privacy` |
| `JWT_SECRET` | `psv`, `privacy` | required; verifies the student/teacher JWT on their user-facing routes |
| `DB_PASSWORD` | `psv` (via the shared Postgres URL) | required |
| `PSV_DB_SCHEMA` | `psv` | defaults to `psv_db` |
| `KG_TEST_MODE` | `kg` | `'false'` in compose — runs against real Neo4j, not the memory stub |
| `GNN_LANE` | `gnn` (all 4 compose entries) | `preference` or `knowledge` — selects which lane this deployment serves |
| `GNN_MODEL_ARTIFACT` | `gnn` (all 4) | path to the lane's `model.json` on the shared volume |
| `GNN_SHADOW_MODE` | `preference-gnn`, `knowledge-gnn` | `'true'` in current compose — inference always returns `eligible: false` (log-only, no downstream effect) |
| `PORT` | `kg` (3012), `decisions` (3014), `psv` (3011) | `gnn`/`privacy` ports are hardcoded in their Dockerfiles/commands instead |
| `NEO4J_URI` / `NEO4J_USER` | `kg` | point at the neo4j container |
| `GNN_SERVICE_URL` / `GNN_TRAINER_URL` / `KG_SERVICE_URL` / `DECISION_SERVICE_URL` / `LMS_SERVICE_URL` | `psv` | see dependency map above; `PSV_SERVICE_URL`/`DISCOVER_SERVICE_URL`/`QUIZ_SERVICE_URL` are also set on `psv` but unused by its code |
| `LMS_SERVICE_URL` / `PSV_SERVICE_URL` | `privacy` | see dependency map above; `KG_SERVICE_URL`/`DECISION_SERVICE_URL`/`DISCOVER_SERVICE_URL`/`QUIZ_SERVICE_URL` are also set on `privacy` but unused by its code |

## Running standalone

Each service is a self-contained FastAPI app with its own `requirements.txt`
and `Dockerfile` (all `python:3.12-slim`, `pip install -r requirements.txt`,
`uvicorn main:app --host 0.0.0.0 --port <N>`). To run one directly:

```bash
cd services/kg   # or decisions / psv / privacy / gnn
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
INTERNAL_SERVICE_TOKEN=dev-token uvicorn main:app --port 3012
```

To run the full graph as it actually depends together, you need at minimum:

1. **Neo4j** running and reachable, for `kg`.
2. **Postgres** running and reachable (with a `psv_db` schema — `psv` does not
   appear to run its own migrations in what was copied here; check for a
   `psv/alembic/` or equivalent before assuming `init_db()` in `main.py`
   creates the schema from scratch — it calls SQLAlchemy's `init_db()` which
   typically does `Base.metadata.create_all`, sufficient for a fresh schema).
3. `kg`, `decisions`, and the `knowledge-gnn` / `knowledge-gnn-trainer` pair up
   first (in that dependency order), since `psv` calls all three.
4. `psv` up next (needs `kg`, `decisions`, `knowledge-gnn*`, and Postgres).
5. `privacy` last (needs `psv`, and `services/lms` from the main monorepo for
   roster lookups — not included here).
6. If you want the preference lane too (`preference-gnn` /
   `preference-gnn-trainer`), they're independent of the knowledge lane and of
   everything else in this repo — nothing here calls them; only
   `services/discover` (in the main monorepo) does.

None of these 5 services are reachable from outside the Docker network except
`psv` (`/api/psv`) and `privacy` (`/api/privacy`), which have Traefik routes in
the source `docker-compose.yml`. `kg`, `decisions`, and all 4 `gnn` variants are
internal-only by the source repo's own routing config — if you stand this repo
up behind your own gateway, that's a deliberate exposure decision you're making
that the source repo did not make.

## Test suites (copied, not re-run as part of this extraction)

Each service ships its own `tests/` directory (pytest):

- `kg/tests/`: `test_repository.py`, `test_neo4j_contract.py` (the latter is
  `skipif`-guarded on `CORRECTIONS_NEO4J_URI` — needs a real isolated Neo4j to
  actually run, skips cleanly without one)
- `decisions/tests/`: `test_policy.py`
- `psv/tests/`: `test_provenance.py`, `test_prerequisites.py`,
  `test_gnn_client.py`, `test_trust_boundary.py`, `test_scoring.py`,
  `test_training_client.py`, `test_schema.py`, `test_refresh_lease.py`,
  `test_campaigns.py`
- `privacy/tests/`: `test_guard.py`, `test_policy.py`
- `gnn/tests/`: `test_serving.py`, `test_models.py`, `test_trainer.py`

Run per-service with `cd services/<name> && pip install -r requirements.txt &&
pytest -q`. This extraction did not execute them — verify they pass in your
own environment before trusting this copy.

## Cruft observed and left as-is (per "copy AS-IS" instruction)

`services/kg/kg`, `services/decisions/decisions`, `services/psv/psv`, and
`services/gnn/gnn` are each a **dangling, self-referential relative symlink**
(e.g. `services/kg/kg -> ../../../../services/kg`) — four levels up from a
directory only two levels deep, so it resolves outside the actual repo root
entirely, both in the original monorepo and here. `services/privacy` has no
such symlink. These appear to be leftover artifacts from some earlier tooling
or a stray `ln -s` command; they are not referenced by any Dockerfile, import,
or config read in this extraction, and are harmless to leave or delete. Copied
here unmodified because the task was to copy these directories as-is;
consider deleting them if they trip up `git add`, an IDE indexer, or a
recursive `COPY` step.

## Provenance

Extracted 2026-09-16 from `/Users/hitesh/Work/Roognis Ai/Roognis Ai
(versions)/roognis-product`, working tree state (uncommitted changes on top of
commit `ce08c39 "Import engineer LMS foundation"`). The source repo was not
modified by this extraction.
