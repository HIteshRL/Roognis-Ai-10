# Roognis core API services

Eight independently-deployable services extracted from the `roognis-product` monorepo
(`services/auth`, `services/ai`, `services/analytics`, `services/quiz`, `services/practice`,
`services/discover`, `services/school-ops`, `services/reporting`), copied as-is from the
**current on-disk state** of that repo (which had 249 uncommitted changes on top of its last
commit — this snapshot reflects that working tree, not the last commit).

This is a reference bundle, not a monorepo merge. There is **no shared tooling, no shared
`node_modules`, and no cross-service imports** — each service still has its own
`package.json`/`Dockerfile`/Prisma schema (or `requirements.txt`/`Dockerfile` for the one Python
service) and must be built and deployed independently, exactly as it was in the source repo.
Where a service duplicates shared logic — most notably `structured-llm.js`, the LLM
provider-selection module — every copy is preserved on purpose. **Do not deduplicate.** That
duplication is the source repo's own documented pattern (no monorepo tooling exists there
either), and collapsing it into a shared package would silently change the deployability
guarantees each service currently has.

## Services

| Service | Stack | Port | Path prefix | DB schema |
|---|---|---|---|---|
| `services/auth` | Express + Prisma | 3001 | `/api/auth` | `auth_db` |
| `services/ai` | Express + Prisma | 3002 | `/api/ai` | `ai_db` |
| `services/analytics` | Express + Prisma | 3004 | `/api/analytics` | `analytics_db` |
| `services/quiz` | Express + Prisma | 3005 | `/api/quiz` | `quiz_db` |
| `services/practice` | Express + Prisma | 3007 | `/api/practice` | `practice_db` |
| `services/discover` | Express + Prisma | 3008 | `/api/discover` | `discover_db` |
| `services/school-ops` | Express + Prisma | 3015 | `/api/school-ops` (+ some unprefixed `/internal/v1/*`, `/health*` — see below) | `school_ops` |
| `services/reporting` | FastAPI + SQLAlchemy | 3017 | `/api/reporting` | `reporting_db` |

All ports/prefixes/schemas above were read directly from each service's own source
(`server.js`/`src/server.js` listen calls, Prisma `schema.prisma` datasource blocks, FastAPI
route decorators, and `docker-compose.yml`'s Traefik labels in the source repo) — not assumed.

`services/school-ops` and `services/reporting` were not in the source repo's own
`CLAUDE.md` documentation table; both were verified from scratch for this extraction.
`school-ops` is a school/membership control-plane service (idempotent writes, an outbox event
log, role grants) built around `prisma/schema.prisma`'s multi-schema `school_ops` schema. Note
it deviates from the other six Node services' routing convention: its internal routes
(`/internal/v1/meta/capabilities`, `/internal/v1/memberships/:id/context`,
`/internal/v1/authorization/check`) are **not** under `/api/school-ops/internal/*` the way every
other service's internal routes are — they sit at the bare `/internal/v1/*` path, alongside one
that *is* prefixed (`POST /api/school-ops/internal/v1/schools`). Verify Traefik routing rules
before assuming the unprefixed ones are reachable the same way. `reporting` is a read-only
aggregator that assembles a parent-facing report from other services' own APIs (it computes
nothing itself — see `services/reporting/sources.py`).

## Verified dependency map

Built by grepping each service's actual runtime source (`server.js`/`src/server.js`, `routes/`,
`lib/`) for `*_SERVICE_URL` env var usage and internal-route calls — **not** copied from
`CLAUDE.md`'s prose. Dev-only scripts (`scripts/seed-demo-history.js`, which several services
carry and which calls `AUTH_SERVICE_URL`/`QUIZ_SERVICE_URL` to seed demo data) are excluded from
this map since they don't run in the deployed service.

```
auth        →  (none — leaf/foundation service, calls no other service)
ai          →  discover (interest-context read + preference-observations write),
                quiz (student-learning-context), practice (student-learning-context),
                analytics (fire-and-forget event ingestion)
                [out of scope: rag, psv, lms]
analytics   →  (none via HTTP — see cross-schema exception below)
quiz        →  ai (quiz draft generation), discover (card-attempt-outcomes),
                analytics (event ingestion)
                [out of scope: rag, psv, kg, lms — the LMS quiz-bridge lives here]
practice    →  quiz (concept-catalog), discover (card-attempt-outcomes),
                analytics (event ingestion)
                [out of scope: rag, psv, lms]
discover    →  ai (interest-graph + learning-profile cold-start import),
                quiz (student-learning-context), practice (student-learning-context),
                analytics (event ingestion)
                [out of scope: rag, decisions]
school-ops  →  (none — its worker posts to a generic, operator-configured
                SCHOOL_OPS_OUTBOX_DELIVERY_URL webhook, not a named peer service)
reporting   →  auth (parent→student lookup), analytics (parent dashboard)
                [out of scope: lms, psv — and reporting hard-depends on both being
                healthy at startup, unlike every other cross-service call here,
                which fails open]
```

Nothing in this repo calls `school-ops` or `reporting` — both are consumed directly by
clients (frontend/web) through Traefik, not by peer services.

### Discrepancies found vs. the source repo's `CLAUDE.md`

`CLAUDE.md`'s prose summarizes the map roughly as: `ai→rag/quiz/practice/discover/lms/psv`,
`analytics called-by-all`, `quiz→rag/ai/analytics/kg/psv/lms/discover`,
`practice→rag/lms/quiz/psv/discover`, `discover→ai/analytics/decisions/rag/quiz/practice`. Per
this repo's own conflict-resolution rule (actual code wins), spot-checking that against source
turned up:

- **`practice→analytics` is real but missing from the prose list.** `services/practice/server.js`
  fires `POST /api/analytics/event` (fire-and-forget, same pattern as ai/quiz/discover) — the
  summary's `practice→rag/lms/quiz/psv/discover` line omits it.
- **"Analytics called-by-all" overstates it.** Verified callers of `POST /api/analytics/event`
  are `ai`, `quiz`, `practice`, and `discover` — **not** `auth` or `school-ops`. `reporting` also
  calls analytics, but via a `GET` on the parent-dashboard endpoint, not event ingestion. And
  `analytics` itself makes **zero** outbound HTTP calls to any other service — see the
  cross-schema exception below, which is a direct DB read, not a service call.
- **`school-ops` and `reporting` are absent from the map entirely**, which is expected — the
  task brief already notes neither was in the original documentation. Both are now included
  above, freshly verified.
- Everything else in the prose summary (`ai→rag/quiz/practice/discover/lms/psv`,
  `quiz→rag/ai/analytics/kg/psv/lms/discover`, `discover→ai/analytics/decisions/rag/quiz/practice`)
  checked out against source.
- Separately (not part of the dependency map, but found while verifying `middleware/auth.js`
  identity per `CLAUDE.md`'s "every Node service carries an identical middleware/auth.js"
  claim): the six files are **functionally** identical (same `requireAuth`/`requireRole` logic,
  same JWT cookie/secret handling) but not byte-identical — cosmetic whitespace differences only,
  confirmed with `diff`. `services/school-ops` doesn't have a `middleware/auth.js` at all; its
  equivalent logic lives in `src/security.js` with its own `requireAuth`/`requireInternalToken`,
  which is consistent with it predating/sitting outside the documented six-service pattern.
- Also separately: `CLAUDE.md`'s "Gotchas" section claims every Dockerfile runs
  `[ -f package.json ] && npm ci || true` (silently swallowing a missing-lockfile failure). The
  Dockerfiles copied into this repo instead run a plain `RUN npm ci` with no guard and no `|| true`
  — so that specific failure mode no longer applies to any of the eight services as copied here,
  though a missing lockfile would still hard-fail the build now (which is arguably the safer
  behavior). All eight services do have a committed lockfile (`package-lock.json` ×7,
  `requirements.txt` for `reporting`), so this wasn't exercised either way.

## Shared infrastructure

- **Auth**: JWT in an httpOnly cookie named `jwt`, verified with a shared `JWT_SECRET`. Six of
  the seven Node services (all but `school-ops`) carry a `middleware/auth.js` exposing
  `requireAuth` and `requireAuth.requireRole(...roles)` — see the discrepancy note above for the
  actual (not byte-identical, but logically identical) state of that file, and `school-ops`'s
  separate `src/security.js`. Roles are `student | teacher | parent`. `reporting` (Python)
  re-implements the same JWT-cookie contract in `auth.py`.
- **Service-to-service auth**: `INTERNAL_SERVICE_TOKEN`, checked on every `/api/*/internal/*`
  (or, for `school-ops`, `/internal/v1/*`) route, bypassing the user JWT entirely.
  **These routes are reachable through the public Traefik entrypoint** — Traefik routes on the
  service's path prefix, not on `internal` as a segment, so the shared token is the *only*
  boundary protecting them. Never assume an `/internal/*` route is safe because it "should" be
  unreachable from outside.
- **Cross-schema exception — no longer present in this extraction**: the source monorepo's
  `services/analytics/lib/student-access.js` used to read `auth_db.users` directly with a raw,
  cross-schema `prisma.$queryRaw`, which this section previously described as "copied
  unmodified." That's now stale. In this repo, `student-access.js` calls
  `lib/auth-student-directory.js`, which hits `GET /api/auth/internal/students/:id?schoolId=`
  and `GET /api/auth/internal/schools/:id/students` on `services/auth` over HTTP via
  `AUTH_SERVICE_URL` + `INTERNAL_SERVICE_TOKEN` (matching routes: `services/auth/server.js`).
  This is the correct shape for `analytics` and `auth` being separate, independently deployable
  services with separate databases — a same-process cross-schema query isn't possible once
  they're split. See `services/analytics/README.md`'s own (accurate) description of the
  `AUTH_SERVICE_URL` contract, and `services/analytics/lib/auth-student-directory.test.js` for
  coverage.
- **Prisma**: dev workflow is `prisma db push`; production is `prisma migrate deploy` — a schema
  change without a generated migration will work locally and break in a `migrate deploy`
  environment. Every Node service here (including `school-ops`) ships its migrations under
  `prisma/migrations/`.

## Workers: same source, different mode — not duplicated here

The source repo's `docker-compose.yml` defines `ai-worker`, `practice-worker`, and `quiz-worker`
alongside `ai`, `practice`, and `quiz`. All three workers run the exact same `node server.js`
entrypoint as their non-worker counterpart, from the same `build:` context — the only
difference is `GENERATION_WORKER: 'true'` in the worker's environment block, which switches
that same process into background-job-processing mode instead of (or alongside) serving HTTP.
Since it's the same source tree already copied into `services/ai`, `services/practice`, and
`services/quiz` above, there is nothing separate to copy — deploy the identical image twice,
once with `GENERATION_WORKER=true` and appropriate concurrency (`GENERATION_CONCURRENCY`) set,
if you need a dedicated worker process.

`school-ops-worker` is different in kind: it runs `src/worker.js`, a genuinely separate entry
point from `src/server.js` (an outbox-delivery loop, not an HTTP-mode toggle) — but that file is
already part of the `services/school-ops` copy in this repo, so again nothing extra to add.

`rag-worker` (running `worker.py`) also follows this pattern in the source `docker-compose.yml`,
but `services/rag` itself is out of scope for this extraction, so it's noted here only for
completeness — no `rag` source is included in this repo.

## Environment variables

See [`.env.example`](.env.example) at this repo's root — copy it to `.env` and fill in values.
It was built by grepping the source repo's root `.env.example` (and `docker-compose.yml`'s
service `environment:` blocks, since several variables — the whole `GROQ_*` family — turned out
to be consumed by `services/ai`/`quiz`/`practice`/`discover` but **never documented in either of
the source repo's own `.env.example` files**, dev or production; that gap is called out inline
in the new file rather than silently patched over) for names actually referenced by these eight
services. Required for every service: `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `DB_PASSWORD`
(Postgres-backed services), `DEMO_SCHOOL_ID`.

## Deploying independently

Each service subfolder is a complete, self-contained deployable unit: its own `package.json` +
`package-lock.json` + `Dockerfile` + Prisma schema/migrations (or, for `reporting`,
`requirements.txt` + `Dockerfile`). Nothing in this repo assumes a monorepo build step, a shared
`node_modules`, or a workspace tool (no `lerna`/`turborepo`/`pnpm workspaces` — matching the
source repo's own "no monorepo tooling" architecture). `node_modules/`, `__pycache__/`, and
local dev database files are gitignored here exactly as they were in the source repo; run
`npm install` inside each Node service before its first `docker build` to generate/refresh that
service's own lockfile-backed `node_modules`.

Because several services call peer services that are **not** included in this repo (`rag`,
`lms`, `psv`, `kg`, `decisions` — see the dependency map above), most such calls are written to
fail open (the calling service degrades a specific feature rather than crashing) — this was
verified in source for the LMS quiz-bridge (`services/quiz/lib/lms-quiz-gate.js`) and is the
documented pattern elsewhere in `CLAUDE.md`. The one exception found is `services/reporting`,
which `depends_on: condition: service_healthy` for `lms` and `psv` in the source
`docker-compose.yml` — meaning a standalone deployment of `reporting` from this repo needs those
two external services reachable (or that health-dependency removed/stubbed) to start cleanly at
all, not just to serve every field.
