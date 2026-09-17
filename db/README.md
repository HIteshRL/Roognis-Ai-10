# roognis-db — Cross-Service Database Schema Reference

**This repo is REFERENCE ONLY.** It documents the current data model across
all Roognis services. It is not runnable — each service in its own repo (see
the other repos in this split) owns and migrates its own schema
independently. This repo exists so the full data model can be understood in
one place without cloning every service repo.

Extracted from the `roognis-product` monorepo's **current on-disk working
tree** (not the last commit — see the migration-deletion caveat below) on
2026-09-16.

## Architecture this reflects

One physical PostgreSQL database (`roognis`) shared by every Node/Python
service, with **schema-per-service** isolation — each service owns exactly
one Postgres schema and, in the normal case, no service queries another
service's schema directly. `services/kg` is the one service that isn't
Postgres at all (Neo4j). `services/decisions`, `services/privacy`, and
`services/gnn` own no database of their own — see their sections below.

---

## Retired Analytics → Auth cross-schema read

Earlier extraction material documented Analytics querying `auth_db.users`
directly to attest a student and list a school's students. That coupling is
retired. Analytics now calls Auth's internal-token-protected, deliberately
narrow directory contract instead:

- `GET /api/auth/internal/students/:studentId?schoolId=...` attests one
  student in one school, preserving a 404 for an unknown/non-student and a
  403 for a known student in another school; it returns only `studentId` and
  `schoolId` on success.
- `GET /api/auth/internal/schools/:schoolId/students` returns only the ordered
  `studentIds` for that school.

The endpoints do not expose a general user lookup or user PII. Auth remains
the only service that queries and owns `auth_db.users`; Analytics owns only
its `analytics_db` data.

---

## Schemas found

| Schema | Service | Stack | Owns |
|---|---|---|---|
| `auth_db` | `services/auth` | Prisma | `School`, `User`, `ParentStudent` |
| `ai_db` | `services/ai` | Prisma | Tutor chat, onboarding, interest graph, visuals/explainers |
| `rag_db` (default; via `rag_db_schema`) | `services/rag` | SQLAlchemy (no Alembic — `create_all`) | Documents, ingestion jobs, extracted entities, retrieval chunks |
| `analytics_db` | `services/analytics` | Prisma | `Event`, `Attendance`, `Score`, `ClassAssignment` |
| `quiz_db` | `services/quiz` | Prisma | Chapter-sourced quizzes, questions, attempts, approval gate |
| `lms_db` | `services/lms` | SQLAlchemy + Alembic | Classrooms, coursework, submissions, gradebook, roster |
| `practice_db` | `services/practice` | Prisma | Ungated practice sets (summary + flashcards + MCQ), attempts |
| `discover_db` | `services/discover` | Prisma | Discover feed: interests, articles, hunts, academic/video cards |
| `psv_db` (default; via `psv_db_schema`) | `services/psv` | SQLAlchemy (no Alembic — `create_all` + additive idempotent `ALTER`s) | Learning events, evidence, trait/knowledge-gap/retention state, decisions |
| `reporting_db` (default; via `reporting_db_schema`) | `services/reporting` | SQLAlchemy (no Alembic — `create_all`) | `ReportPolicy` (single table) |
| `school_ops` | `services/school-ops` | Prisma | School onboarding/roster workflow: memberships, role grants, approvals, outbox |
| *(Neo4j graph, not Postgres)* | `services/kg` | Neo4j driver, hand-written Cypher (`ensure_schema`) | Knowledge graph: `KnowledgeNode` (Concept/Misconception/AssessmentItem/Taxonomy) + typed relationships |
| — none — | `services/decisions` | stateless | No database. Pure policy/scoring functions (`policy.py`) over inputs it's given; nothing persisted. |
| — none — | `services/privacy` | stateless | No database. Pure aggregation-suppression filter (`policy.py`) over payloads it's given; nothing persisted. |
| — none — | `services/gnn` | stateless (file/artifact-based) | No database. Trains/serves GNN models as in-memory numpy structures + `ModelArtifact` objects; no SQL persistence found. |

Each schema's files live under `schemas/<service-name>/` in this repo.

## Keeping the LMS reference current

The LMS service repository is the sole authority for its SQLAlchemy models
and Alembic chain. This reference now includes migrations `0019` and `0020`
(`Submission.is_late` and guardian-code expiry/uniqueness). Before publishing
a database-reference update, verify the copied LMS material against the
specific LMS checkout that supplied it:

```sh
./scripts/verify-reference.sh /absolute/path/to/lms-services-backend/services/lms
```

The command compares `models.py`, `database.py`, `alembic.ini`, and the full
Alembic directory. It does not apply migrations or make this repository a
database deployment authority.

---

## `schemas/auth` — `auth_db` (Prisma)

Owner: `services/auth`, JWT auth issuer for the whole product.

- `School`
- `User`
- `ParentStudent`

## `schemas/ai` — `ai_db` (Prisma)

Owner: `services/ai`. The largest single schema — tutor chat, generated
content, and the (deprecated-in-progress) legacy interest graph:

`ChatSession`, `Message`, `ImageJob`, `Feedback`, `StudentOnboarding`,
`StudentLearningProfile`, `StudentNewsArticle`, `StudentInterestNode`,
`StudentInterestEdge`, `StudentNewsSignal`, `StudentInterestProfile`,
`SafetyReviewFlag`, `VisualArtifact`, `StudyVisual`, `StudyResumeContext`,
`PreferenceDelivery`, `GenerationTask`.

(Per `CLAUDE.md`, the `StudentInterest*`/`StudentNewsSignal` tables here are
the pre-`services/discover` legacy graph; `/api/ai/news*` and
`/api/ai/interest-graph` are documented as deprecated shims.)

## `schemas/rag` — `rag_db` (SQLAlchemy, no Alembic)

Owner: `services/rag` (FastAPI). Schema is created via
`Base.metadata.create_all` in `database.py`, not migrations:

`Document`, `DocumentIngestionJob`, `EducationalEntity`,
`EntityRelationship`, `RetrievalChunk`.

## `schemas/analytics` — `analytics_db` (Prisma)

Owner: `services/analytics`, described in `CLAUDE.md` as **"the only
aggregate surface"** in the product (teacher dashboards, interventions,
per-student summaries):

`Event`, `Attendance`, `Score`, `ClassAssignment`.

## `schemas/quiz` — `quiz_db` (Prisma)

Owner: `services/quiz`. The teacher-approval-gated quiz pipeline (`Quiz`
defaults to `pending_review`, per `docs/backend-services/CHAPTER_QUIZ_GENERATION_PLAN.md`
and `services/quiz/lib/quiz-status.js`):

`ChapterQuizSource`, `Quiz`, `QuizAttempt`, `QuizQuestion`,
`QuizGenerationJob`, `EvidenceOutbox`, `GenerationTask`.

## `schemas/lms` — `lms_db` (SQLAlchemy + Alembic)

Owner: `services/lms` (FastAPI), the `/classroom` sub-app's backend —
Google-Classroom-parity domain, distinct from the `frontend/` product
domain:

`Term`, `Classroom`, `Chapter`, `Enrollment`, `Coursework`, `Submission`,
`CourseworkTarget`, `Topic`, `ClassroomGroup`, `ClassroomGroupMember`,
`Announcement`, `Comment`, `CommentReaction`, `Rubric`, `Guardian`,
`Notification`, `Upload`, `GradeHistory`, `CalendarEvent`,
`CurriculumVersion`, `QuizScoreReceipt`.

`QuizScoreReceipt` and `Coursework.quiz_id` (no FK — see the C7 note above)
are the two sides of "the quiz bridge" documented in `CLAUDE.md`, the first
Node→`/api/lms` integration.

## `schemas/practice` — `practice_db` (Prisma)

Owner: `services/practice`, a deliberate exception to `MASTERCONTEXT.md`
§6's cap on new services (documented as such in `CLAUDE.md`). Ungated —
never shares a status enum or table with `quiz_db`:

`PracticeSet`, `PracticeAttempt`, `FlashcardReviewState`, `EvidenceOutbox`,
`GenerationTask`.

## `schemas/discover` — `discover_db` (Prisma)

Owner: `services/discover`, also a deliberate exception to `MASTERCONTEXT.md`
§6 (documented in `CLAUDE.md`). The largest schema after `ai_db` — owns the
whole Discover surface end to end:

`InterestTopic`, `InterestNode`, `InterestEdge`, `InterestCandidate`,
`DiscoverArticle`, `NewsSignal`, `StudentInterestProfile`,
`StudentPreference`, `PreferenceObservation`, `PreferenceRefreshRun`,
`PreferenceDecisionRecord`, `HuntRun`, `AcademicCard`,
`AcademicCardAttempt`, `VideoHuntRun`, `DiscoverVideo`, `TrustedChannel`,
`VideoSignal`, `PreferenceControl`, `PreferenceReceipt`.

## `schemas/psv` — `psv_db` (SQLAlchemy, no Alembic)

Owner: `services/psv` ("Learner State" per `MASTERCONTEXT.md`'s Layer
naming — one of the four sanctioned Layer 2+ additions). Schema is created
via `create_all` and then evolved with hand-written, idempotent
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in `database.py`
(no migration framework yet — the code comments explain this is deliberate
for a pilot-stage schema):

`LearningEvent`, `EvidenceRecord`, `TraitState`, `KnowledgeGapSnapshot`,
`RefreshRun`, `DecisionRecord`, `RetentionState`, `InterventionCampaign`,
`InterventionDelivery`, `CampaignProjection`.

Notable: this is where the hard rule **"no learner-state write without
`event_ids[]`, `gate_version`, `model_version`"** (`CLAUDE.md`, Hard
architectural rules) is structurally enforced — the additive `ALTER`s add
exactly those columns (`event_ids`, `gate_version`, `decision_source`) to
`trait_states`, `knowledge_gap_snapshots`, and `retention_states`.

## `schemas/reporting` — `reporting_db` (SQLAlchemy, no Alembic)

Owner: `services/reporting`. Smallest schema — a single table:

`ReportPolicy`.

## `schemas/school-ops` — `school_ops` (Prisma)

Owner: `services/school-ops`, per `CLAUDE.md`'s **D1 (Sprint 0)** promotion
note. Newest schema on disk (single migration,
`20260912010000_school_ops_foundation`):

`School`, `SchoolMembership`, `RoleGrant`, `StudentProfile`,
`GuardianRelationship`, `RosterImportJob`, `WorkflowRun`,
`WorkflowStepRun`, `ApprovalTask`, `OutboxEvent`, `CommandReceipt`,
`IdempotencyRecord`, `AuditEvent`.

Note `school_ops.School` exists alongside `auth_db.School` — two services
each define a `School` model in their own schema. This repo does not judge
whether that's intentional duplication or drift; it's flagged here because
it's the kind of thing a reference repo like this should make visible
rather than silently normalize away.

## `schemas/kg` — Neo4j (not Postgres)

Owner: `services/kg`. Not part of the `roognis` Postgres database at all —
a separate Neo4j graph, defined by hand-written Cypher in
`GraphRepository.ensure_schema()` (`repository.py`) plus the Pydantic
node/relationship contracts in `schemas.py`:

- Node label: `KnowledgeNode`, kinds `Concept | Misconception |
  AssessmentItem | Taxonomy`, unique constraint on `nodeId`, indexes on
  `kind` and `status`.
- Relationship kinds: `PREREQUISITE_OF`, `SIBLING_OF`, `MEASURES`,
  `DISTRACTOR_FOR`, `IN_TAXONOMY`, each restricted to specific
  node-kind pairs (`RELATIONSHIP_ENDPOINTS` in `schemas.py`).
- Activation is gated: a node/edge may only go from `proposed` to `active`
  via one of two named authorities (`ACTIVATION_AUTHORITIES` in
  `schemas.py`) — `teacher_quiz_approval` or `lms_curriculum_publish` — not
  by whoever holds the internal service token.

Copied here (`schemas.py`, `repository.py`) even though it's not Postgres,
because the task asked for the full cross-service data model in one place.

## `services/decisions`, `services/privacy`, `services/gnn` — no schema

Explicitly verified, not assumed:

- **`services/decisions`**: no `models.py`, `database.py`, `alembic/`, or
  `prisma/` anywhere in the service; no `sqlalchemy`/`postgres`/`DATABASE_URL`
  reference in any of its `.py` files. `policy.py` is pure functions over
  request payloads (`preference_decision`, etc.) — it computes and returns,
  it does not persist.
- **`services/privacy`**: same check, same result. `policy.py`'s
  `privacy_filter_aggregate` suppresses/passes through payloads it's given;
  nothing is written anywhere.
- **`services/gnn`**: no `models.py`/`database.py`/`alembic`/`prisma`
  either. It trains and serves GNN-style models as in-memory
  numpy/dataclass structures (`graph_models.py`, `artifacts.py`'s
  `ModelArtifact`), not SQL rows.

Per the task instructions: this is noted explicitly rather than guessed —
these three services genuinely appear to own no database, not merely "we
didn't find it."

---

## Migration-deletion caveat — READ BEFORE TRUSTING ANY `migrations/` FOLDER HERE

The source monorepo's working tree had **249 uncommitted changes** at
extraction time, and a number of them were **deletions of previously
committed Prisma migration folders**. This repo mirrors the **current
on-disk state**, i.e. it deliberately **does not** include the deleted
migrations, even though they still exist in the source repo's last git
commit (`ce08c39`). If you diff this repo's `schemas/*/prisma/migrations/`
against that commit, you will see files "missing" — that is intentional
and matches what's actually on disk in `roognis-product` right now.

**What we found**, by service — deleted migration folders (confirmed absent
from disk, present in `git status` as `D`), versus what currently exists on
disk instead:

| Service | Deleted (absent from this repo) | Currently on disk (copied into this repo) |
|---|---|---|
| `services/ai` | `20260717120000_initial`, `20260730120000_interest_graph`, `20260730140000_safety_review_flags`, `20260807120000_visual_artifacts` | `20260908000000_product_baseline`, `20260912000000_tutor_page_vision`, `20260913090000_study_visuals` |
| `services/analytics` | `20260717120000_initial` | `20260908000000_product_baseline` |
| `services/auth` | `20260717120000_initial`, `20260822090000_user_school_role_index` | `20260908000000_product_baseline` |
| `services/discover` | `20260812090000_init`, `20260818090000_academic_cards`, `20260821090000_tone_rewrite`, `20260821100000_academic_card_kind`, `20260822090000_video_recommendations` | `20260908000000_product_baseline` |
| `services/practice` | `20260808090000_init`, `20260818100000_practice_targeting` | `20260908000000_product_baseline` |
| `services/quiz` | `20260717120000_initial`, `20260730130000_quiz_approval_gate` | `20260908000000_product_baseline` |
| `services/school-ops` | *(none — new service, one migration on disk)* | `20260912010000_school_ops_foundation` |
| `services/lms` (Alembic) | *(none observed — all 18 `alembic/versions/*.py` files were present on disk and copied: `0001_baseline` through `0018_quiz_score_receipts`)* | — |

**Reading this table honestly:** every deleted folder predates
`20260908000000_product_baseline` (2026-09-08) for its service, and every
surviving/current folder is that baseline or newer. This is consistent with
each Prisma service's migration history having been **squashed into a
single baseline migration** on 2026-09-08, with normal incremental
migrations resuming after that (as seen in `services/ai`, which has two
more on top of its baseline). We did not find a doc on disk recording this
squash explicitly — it's an inference from the dates, not a confirmed fact.

**Whoever picks up migration work from this reference repo should:**
1. Confirm against the live `roognis-product` repo (and its actual deployed
   database migration history, e.g. Prisma's `_prisma_migrations` table)
   whether `20260908000000_product_baseline` truly supersedes the deleted
   folders, or whether this was a work-in-progress local squash that was
   never meant to reach `main`.
2. Not assume this repo's `migrations/` folders are a complete, authoritative
   history — they are a snapshot of one uncommitted working tree at one
   point in time (2026-09-16), not the source repo's git history.
3. Re-run the extraction (or diff against a fresh `roognis-product` clone)
   before relying on this for anything migration-order-sensitive.

---

## Layer-0 caveat

Per `CLAUDE.md`: "Build order is strict (Layers 0–6). Layer 0 — freezing the
event/PSV/KG/evidence contracts — is not complete, so `services/psv` and
`services/decisions` are explicitly not to be written yet." Both
`services/psv` (schema, migrations-free) and `services/decisions`
(schema-less) nonetheless exist on disk and are documented above as found —
this repo reports what's actually there, not what the build order says
should be there yet. Treat `psv_db`'s shape as provisional/pilot, per its
own `database.py` comments.
