# Data Processing Backend (RAG ingestion)

This repo is an extraction of the **data processing backend** from the
`roognis-product` monorepo: the RAG/EKE service (PDF ingestion, chunking,
entity extraction, embeddings, retrieval, chapter context).

Extracted from the monorepo's on-disk state as of 2026-09-16 (the monorepo
had 249 uncommitted changes on top of its last commit; this copy reflects
that working tree, not the last commit).

**2026-09-17: `seed-data/` and `services/rag/seed_textbooks.py` were removed**
ahead of production launch, per the decision to strip demo/seed data from the
codebase entirely. `seed_textbooks.py` was a standalone one-shot script (not
imported by `main.py`, `worker.py`, or the `Dockerfile`'s default command),
so removing it does not affect the `rag`/`rag-worker` container build or
boot. The sections below that describe `seed-data/` and the `textbook-seed`
role are kept for historical/archaeological reference only — that content no
longer exists in this repo. If NCERT textbook ingestion is needed again for
local dev, upload PDFs through the ordinary `POST /api/rag/upload` endpoint
instead.

## What's in this repo

```
services/rag/    FastAPI + SQLAlchemy service — PDF ingestion, chunking,
                 entity extraction, embeddings, retrieval, chapter context
```

### `services/rag/`

Port **3003**, path prefix **`/api/rag`** (and internal-token-gated
`/api/rag/internal/*`).

Key files:
- `main.py` — FastAPI app: upload/ingestion endpoints, document listing,
  student/teacher-facing retrieval routes, internal routes
  (`/api/rag/internal/chapters`, `/api/rag/internal/chapter-context`,
  `/api/rag/internal/retrieve`, `/api/rag/internal/page-context`), the
  `notify_quiz_service_chapter_ready` outbound call, and the
  `student_document_ids` outbound call to LMS.
- `eke_pipeline.py` — chunking + educational-entity-extraction pipeline run
  on ingestion.
- `chunking.py` — PDF chunking logic.
- `retrieval.py` — embedding (Ollama) + vector search (ChromaDB) for
  retrieval-augmented queries.
- `curriculum_publish.py` — best-effort delivery of curriculum graph
  operations to a Knowledge Graph service (`KG_SERVICE_URL`); currently a
  no-op in practice since `services/kg` does not exist yet
  (`ARCHITECTUREDesign.md` Layer 0 — KG/PSV/decisions contracts — is not
  complete in the source repo).
- `worker.py` — background worker process; on completing an ingestion job it
  calls the same `notify_quiz_service_chapter_ready` and
  `publish_curriculum_content` functions `main.py` defines.
- `seed_textbooks.py` — one-shot seeding script that logs in as the demo
  teacher against Auth, then uploads a manifest of textbook PDFs to this
  service's own `/api/rag/upload`.
- `auth.py`, `database.py`, `models.py`, `config.py` — JWT verification
  (shared `JWT_SECRET`), SQLAlchemy session/engine setup, ORM models,
  environment-driven settings (`pydantic-settings`).
- `backfill_passage_chunks.py` — one-off backfill script.
- `tests/` — pytest suite (auth, curriculum publish, documents, health,
  internal chapter-context, models, retrieval).
- `rag` (inside `services/rag/`) — a **broken symlink** in the source repo
  (`services/rag/rag -> ../../../../services/rag`, resolving outside the
  monorepo entirely). Copied as-is per the source instructions; it was
  already non-functional in the source repo and remains so here. Safe to
  delete if it causes tooling to trip over it.

## `rag` / `rag-worker` / `textbook-seed` — one codebase, three entrypoints

Verified directly from the monorepo's `docker-compose.yml`: all three
service blocks build from `./services/rag` (`build: ./services/rag`) — they
are the **same image**, differing only in the container command:

| Compose service | Command | Role |
|---|---|---|
| `rag` | (Dockerfile default: `python main.py`) | The FastAPI HTTP server, port 3003, routed by Traefik on `/api/rag` |
| `rag-worker` | `python worker.py` | Background ingestion worker, same env, no Traefik route |
| `textbook-seed` | `python seed_textbooks.py` | One-shot job (profile `seed`) that logs into Auth as the demo teacher and uploads the NCERT manifest via HTTP to the running `rag` service |

All three mount `./seed-data:/app/seed-data:ro`. `textbook-seed` additionally
reads `TEXTBOOK_SEED_MANIFEST=/app/seed-data/ncert/class-8-textbooks.json`.

This repo copies `services/rag/` once; running any of the three roles is a
matter of which command you launch it with (see "Running standalone"
below).

### `seed-data/`

Not a live API service — copied here because it is data-processing/seeding
infrastructure that the RAG service (via `textbook-seed`) and other
services' demo-history seeders depend on.

```
seed-data/ncert/                        NCERT Class 8 PDFs (math, science,
                                         social science) + the seed manifest
                                         seed-data/ncert/class-8-textbooks.json
seed-data/ingest_ncert_class6_english.py  Standalone one-off ingestion script
seed-data/demo-history/plan.json        Fixture: which demo personas exist,
                                         and chapterIntent (preferred subjects
                                         + chapter counts) per persona — no
                                         chapter names or ids, by design (see
                                         monorepo CLAUDE.md: the fixture names
                                         no chapters).
seed-data/demo-history/lib/             Pure Node.js logic consumed by other
                                         services' own seeder scripts
                                         (services/ai, services/quiz,
                                         services/analytics each run their own
                                         scripts/seed-demo-history.js — those
                                         scripts themselves live in those
                                         services, NOT in this repo):
  chapter-select.js                     rendezvous-hashes which chapters
                                         (from live GET /api/rag/internal/chapters)
                                         each persona studies
  demo-corpus.js                        pulls chapter text/entities via RAG
  chapter-qa-llm.js                     LLM-written Q&A over a chapter's own
                                         retrieved chunks (OpenRouter -> Groq
                                         provider chain)
  chapter-qa.js                         deterministic templating fallback
                                         (used with no LLM key, or on any
                                         chapter-qa-llm.js failure)
  demo-ids.js                           demoId(email, kind, dayOffset) — pure
                                         function, no chapter info, so re-seeds
                                         update rows in place
  demo-plan.js                          expands plan.json into concrete
                                         per-persona seed instructions
  rag-chapters.js                       thin client for GET /api/rag/internal/chapters
  *.test.js                             companion unit tests for each module
                                         above
```

Note: `seed-data/demo-history/lib/*.js` are **library modules only** — they
have their own test suite but no `server.js`/entrypoint of their own. The
scripts that actually invoke them (`services/{ai,quiz,analytics}/scripts/seed-demo-history.js`)
were intentionally **not** copied into this repo, since this extraction is
scoped to `services/rag/` and `seed-data/` per the task that produced it.
Running the demo-history seed flow requires those three services' code too.

## Dependencies (verified from code, not just docs)

### Outbound (this service calls out to)

| Target | Call | Where | Notes |
|---|---|---|---|
| Quiz | `POST {QUIZ_SERVICE_URL}/api/quiz/internal/chapter-ready` | `main.py::notify_quiz_service_chapter_ready`, invoked from `worker.py` after a background ingestion job completes | Best-effort; no-ops if `QUIZ_SERVICE_URL` or `INTERNAL_SERVICE_TOKEN` is unset. Confirms the CLAUDE.md description. |
| LMS | `GET {LMS_SERVICE_URL}/api/lms/internal/student-documents` | `main.py::student_document_ids` | Resolves which documents a given student may see, for LMS-scoped access. **Not mentioned in the source repo's CLAUDE.md** — found only by reading the code. Read `LMS_SERVICE_URL` straight from `os.environ` (default `http://lms:3006`), not from the `Settings` class. |
| KG (`services/kg`, not yet built) | `PUT {KG_SERVICE_URL}/api/kg/v1/nodes/{id}` and `POST {KG_SERVICE_URL}/api/kg/v1/relationships` | `curriculum_publish.py::deliver_curriculum_graph`, called from `main.py` (`notify_kg` path) and `worker.py::publish_curriculum_content` | Best-effort, idempotent-on-the-far-side by design; currently always a no-op since `services/kg` does not exist in the source monorepo yet (Layer 0 contracts unfinished per `ARCHITECTUREDesign.md`). |
| Auth | `POST {AUTH_SERVICE_URL}/api/auth/login` | `seed_textbooks.py::login_as_teacher` | Only exercised by the one-shot `textbook-seed` job, to obtain a JWT for uploading the seed manifest. |
| Self (`rag`) | `POST {RAG_SERVICE_URL}/api/rag/upload` | `seed_textbooks.py` | The `textbook-seed` job uploads PDFs to the running `rag` HTTP server over the network, not via a direct function call. |

`PINECONE_API_KEY` / `PINECONE_ENV` and `PSV_SERVICE_URL` /
`DECISION_SERVICE_URL` / `DISCOVER_SERVICE_URL` are set as environment
variables for the `rag`/`rag-worker` containers in the monorepo's
`docker-compose.yml`, but **none of them are referenced anywhere in
`services/rag`'s code** — confirmed by grep. They are forward-looking/dead
in the copied code as of this extraction. Vector storage is ChromaDB
(`CHROMA_URL`) and embeddings are Ollama (`OLLAMA_URL` /
`OLLAMA_EMBEDDING_MODEL`), not Pinecone.

### Inbound (who calls this service)

Verified by grepping the monorepo for `RAG_SERVICE_URL` usage (these callers
are **not** copied into this repo — document only, per the task):

| Caller | File(s) | What it calls |
|---|---|---|
| `services/ai` | `server.js`, `visuals/grounding.js` | tutor-chat grounding, visuals grounding — `GET /api/rag/internal/chapter-context` (per CLAUDE.md; not `retrieveRagChunks`, which projects away `chunkId`/metadata needed for citations) |
| `services/quiz` | `lib/generation.js` | pulls chapter context to draft quiz questions |
| `services/practice` | `grounding.js` | same chapter-grounding pattern for instant practice content |
| `services/discover` | `cards/grounding.js` | grounding for Discover "academic cards" |
| `services/lms` | `curriculum.py`, `config.py` | LMS-side curriculum/document lookups |
| `services/rag` itself | `textbook-seed` job | uploads seed PDFs over HTTP to the running `rag` server (see Outbound table) |

Everything above reads `/api/rag/internal/chapters`, `/api/rag/internal/chapter-context`,
or `/api/rag/internal/retrieve` — all gated by `INTERNAL_SERVICE_TOKEN` via
`X-Internal-Service-Token`, not by the user JWT.

## Environment variables

Read from `services/rag/config.py` (`pydantic-settings`, `.env` file
supported, unknown keys ignored) plus the direct `os.environ`/`os.getenv`
reads in `main.py` and `seed_textbooks.py`. Defaults shown are the code's
own fallbacks, not necessarily good production values.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://postgres:postgres@postgres:5432/roognis` | `config.py` | Postgres connection (schema `rag_db`, driver auto-upgraded to `postgresql+psycopg://` if given as plain `postgresql://`) |
| `RAG_DB_SCHEMA` | `rag_db` | `config.py` | Postgres schema name |
| `JWT_SECRET` | `dev-only-rag-secret` | `config.py`/`auth.py` | Shared secret to verify user JWTs (must match every other service in the deployment) |
| `CHROMA_URL` | `http://chromadb:8000` | `config.py`/`retrieval.py` | ChromaDB HTTP endpoint |
| `OLLAMA_URL` | `http://ollama:11434` | `config.py`/`retrieval.py` | Ollama endpoint for embeddings |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | `config.py`/`retrieval.py` | Embedding model name |
| `FILE_STORAGE_PATH` | `/app/storage` | `config.py` | Shared disk path for uploaded PDFs |
| `RAG_MAX_UPLOAD_MB` | `50` | `config.py` | Max accepted PDF size |
| `RAG_COLLECTION_PREFIX` | `school` | `config.py` | Prefix for per-school Chroma collection names |
| `RAG_TEST_MODE` | `false` | `config.py` | Lightweight test defaults for pytest/TestClient (deterministic embeddings; no live Ollama/Chroma required) |
| `DB_POOL_SIZE` | `5` | `config.py` | SQLAlchemy pool size |
| `DB_MAX_OVERFLOW` | `5` | `config.py` | SQLAlchemy overflow connections |
| `QUIZ_SERVICE_URL` | `""` (disabled) | `config.py`/`main.py` | Base URL for chapter-ready notifications to Quiz |
| `KG_SERVICE_URL` | `""` (disabled) | `config.py`/`curriculum_publish.py` | Base URL for curriculum graph delivery to KG (currently always disabled — service doesn't exist yet) |
| `INTERNAL_SERVICE_TOKEN` | `""` (disabled) | `config.py` | Shared token for `/internal/*` routes and outbound internal calls |
| `RAG_RENDER_MAX_EDGE` | `2048` | `config.py` | Max long edge (px) for server-rendered curriculum page images |
| `RAG_RENDER_MAX_BYTES` | `4194304` | `config.py` | Max PNG payload for one page render |
| `RAG_RENDER_MAX_CONCURRENT` | `4` | `config.py` | Concurrent page-render cap |
| `RAG_RENDER_TIMEOUT_SECONDS` | `8` | `config.py` | Per-render wall-clock budget |
| `LMS_SERVICE_URL` | `http://lms:3006` | `main.py` (`os.environ.get`, **not** in `Settings`) | Base URL for the `student_document_ids` LMS lookup |
| `PORT` | `3003` | `main.py` (`os.environ.get`) | HTTP port for `uvicorn.run` |
| `DEMO_SCHOOL_ID` | (unset) | set in `docker-compose.yml` for `rag`/`rag-worker`/`textbook-seed`, not read anywhere in `services/rag`'s own code | Present for parity with other services; appears unused here — verify before relying on it |
| `AUTH_SERVICE_URL` | `http://auth:3001` | `seed_textbooks.py` | Auth base URL, for `textbook-seed` login |
| `RAG_SERVICE_URL` | `http://rag:3003` | `seed_textbooks.py` | This service's own base URL, for `textbook-seed` to upload against |
| `TEXTBOOK_SEED_MANIFEST` | (compose sets `/app/seed-data/ncert/class-8-textbooks.json`) | `seed_textbooks.py` | Path to the seed manifest listing which PDFs to upload |
| `AUTO_SEED_TEXTBOOKS`, `SEED_TEACHER_EMAIL`, `SEED_TEACHER_PASSWORD` | `true` / `teacher@demo.com` / `demo1234` | `seed_textbooks.py` | Seeding behavior/credentials |

Not read by this service's code (present in the monorepo's compose file for
future services, or dead): `PINECONE_API_KEY`, `PINECONE_ENV`,
`PSV_SERVICE_URL`, `DECISION_SERVICE_URL`, `DISCOVER_SERVICE_URL`.

## Running standalone

This service expects Postgres, ChromaDB, and (for real, non-test-mode
embeddings) Ollama to be reachable. Outside the full monorepo's Docker
Compose stack, the fastest path is `RAG_TEST_MODE=true`, which the source
repo's own demo stack relies on for deterministic embeddings without a live
Ollama/ChromaDB:

```bash
cd services/rag
pip install -r requirements.txt

export DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/roognis
export RAG_TEST_MODE=true
export JWT_SECRET=dev-only-rag-secret
export PORT=3003

python main.py
```

For the background worker or the textbook seed job, run the same image with
a different entrypoint (matching the monorepo's `rag-worker` / `textbook-seed`
compose service definitions):

```bash
python worker.py          # rag-worker role
python seed_textbooks.py  # textbook-seed role — needs AUTH_SERVICE_URL and
                           # RAG_SERVICE_URL pointing at running services,
                           # and ./seed-data mounted/available at
                           # $FILE working directory's ../../seed-data or
                           # wherever TEXTBOOK_SEED_MANIFEST resolves
```

A `Dockerfile` is included and mirrors the monorepo's build: `pip install`
from `requirements.txt`, then `python main.py` (falls back to a
"RAG stub running" sleep if `main.py` is somehow missing).

## Tests

```bash
cd services/rag
pip install -r requirements.txt
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests
```

This matches the monorepo's documented command
(`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest services/rag/tests`,
run from a repo root where `services/rag` is a subdirectory) — verified
against `services/rag/pytest.ini` (`testpaths = tests`, `pythonpath = .`) and
the actual test files under `services/rag/tests/` in this repo. Run from
inside `services/rag/` here since this repo's root *is* effectively what was
previously `services/rag`'s parent-relative path.

The `seed-data/demo-history/lib/` modules have their own Node.js test suite,
included here for completeness even though their consuming scripts are not:

```bash
node --test seed-data/demo-history/lib/*.test.js
```

## Known discrepancies vs. the source repo's `CLAUDE.md`

- CLAUDE.md describes the Quiz-bridge call (`chapter-ready`) but does not
  mention the **LMS outbound call** (`GET /api/lms/internal/student-documents`
  in `main.py::student_document_ids`) or the **KG outbound call**
  (`curriculum_publish.py::deliver_curriculum_graph`). Both are real,
  present in the code, and documented above; the KG one is currently
  inert only because `services/kg` doesn't exist yet in the source repo.
- CLAUDE.md's service table lists `RAG_SERVICE_URL` as something "callers"
  reference, without enumerating them. Verified callers by grep:
  `services/ai`, `services/quiz`, `services/practice`, `services/discover`,
  `services/lms`, plus this service's own `textbook-seed` role.
- Everything else checked (port 3003, prefix `/api/rag`, the
  `rag`/`rag-worker`/`textbook-seed` triad sharing one build context, the
  pytest command, `RAG_TEST_MODE`) matched the code exactly as of this
  extraction — actual code wins over docs per the source repo's own
  conflict-resolution rule, and in this case they agreed.
