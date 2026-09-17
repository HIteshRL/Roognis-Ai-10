# LMS Production Hardening — Google Classroom Parity, on the Split-Repo Architecture

## Context

Production launch is targeted in ~2 weeks. The product vision is "Google Classroom plus an AI study layer on top, like NotebookLM": a teacher uploads study material to a classroom, students in that classroom study it with AI tutoring help, and one teacher can run multiple classrooms simultaneously.

**Architecture decision (this session):** the split repos in this directory — `lms-services-backend`, `teacher-portal`, `parent-portal`, `student-portal` (plus `apis`, `intelligence-decisioning`, `data-processing-backend`, `db`) — are the **real production target**, not the original monorepo. The governing principle: LMS business logic and new capabilities live in the `lms-services-backend` microservice; each portal (teacher/parent/student) integrates with it as a client, not by duplicating logic. LMS API additions should be designed so portals can upgrade to new capabilities independently over time (additive fields, versioned routes for anything breaking) rather than requiring a synchronized redeploy of every portal.

**Critical finding from this session that changes the plan's first step: the split repos are already stale, and the source monorepo is still under active development.** The four repos were split at different times on 2026-09-16 (`lms-services-backend` 16:35, `student-portal` 16:46, `parent-portal` 23:02, `teacher-portal` 23:04), and the monorepo has kept changing since — confirmed by direct file comparison, not assumption:

- **Missing from `lms-services-backend`**: backend edits to `guardians.py`, `models.py`, `coursework.py`, `clients.py`; two new Alembic migrations (`0019_submission_is_late.py`, `0020_guardian_redeemable_code.py`); new/changed test files (`test_features.py`, `test_late_submissions.py`).
- **Missing from `teacher-portal`** (the newest split, still behind): `web/src/features/grading/components/RubricField.tsx` (the entire rubric-authoring UI — confirmed absent by direct file search) and its `lmsService.ts` wrapper functions; edits to `Login.jsx`, `Guardian.jsx`, `PeopleTab.jsx`, `ClassworkTab.jsx`; new timeline-scheduling components (`EditAnnouncementDialog.tsx`, `AnnouncementScheduleControl.tsx`) and `useTimeline.ts`/`timelineService.ts` changes.
- **`student-portal` and `parent-portal`** are equally or more exposed to the same drift (student-portal split earliest, 16:46).

This is not a one-time gap — if the monorepo keeps being edited while the split repos are treated as canonical, this re-sync problem repeats and compounds every day. **Step 0 below is a hard prerequisite to everything else in this plan.**

## Comparison summary: Google Classroom vs. our LMS (unchanged by the architecture decision)

| Area | Google Classroom | Our LMS | Verdict |
|---|---|---|---|
| Draft→Return grade gate | Core mechanic | Implemented correctly, incl. audit trail | **Match** |
| Multi-classroom per teacher | Core | Fully supported, live-tested (3-5 classes) | **Match** |
| Coursework types (Assignment/Quiz/Question/Material) | Core | All four real, correct gradeable/non-gradeable split | **Match** |
| Rubric grading | Core | Scoring engine real; authoring UI exists in monorepo, not yet in `teacher-portal` | **Match (pending sync)** |
| Stream + scheduling + pinning | Core | Real; scheduling UI itself still evolving in monorepo (new Edit/Schedule components) | **Match (pending sync)** |
| Public vs. private comments | Core, 3 channels | 2 of 3 channels correct; comment edit/delete has no UI in any portal | **Partial** |
| Join code (display/copy/reset) | Core | Backend complete; no portal has copy/regenerate UI | **Partial** |
| Guardian access model | Periodic digest EMAIL, never real-time | Live pull dashboard (`parent-portal`'s `Guardian.jsx`), explicitly labeled read-only | **Different by design — needs a decision** |
| Grade categories/weighting | Core setting | Does not exist on either side | **Gap — recommend deferring** |
| Mute student | Core | Does not exist on either side | **Gap — recommend deferring** |
| AI study-material layer ("NotebookLM") | N/A | Real end-to-end (`Library.jsx` in `teacher-portal` → `curriculum.py` in `lms-services-backend` → RAG → `Workspace.jsx` in `student-portal`), but new and never live-tested | **Our differentiator — also our biggest launch risk** |
| `services/psv` retention campaigns | N/A | Undocumented service, already in `intelligence-decisioning`, calls into `lms-services-backend`'s notifications | **Unreviewed scope creep — needs a decision** |

## Recommended plan

### Step 0 — Re-sync the split repos, then freeze the monorepo as the source of truth (gating, do first)

- Pull the specific newer files identified above into their target repos: backend changes + the two new migrations into `lms-services-backend`; `RubricField.tsx` + its `lmsService.ts` wrappers + `Login.jsx`/`Guardian.jsx`/`PeopleTab.jsx`/`ClassworkTab.jsx`/timeline-scheduling components into `teacher-portal`; check `parent-portal` and `student-portal` against the same file list (they weren't individually diffed yet — do that as part of this step, don't assume they're only missing what's listed above).
- **Recommendation: once synced, stop developing directly in the monorepo's `services/lms` and `web/`.** Every day both codebases are edited in parallel, this re-sync cost repeats. If other engineers or sessions are actively working in the monorepo, they need to be redirected to the split repos before this hardening pass starts, or the P0 work below will itself go stale mid-flight.
- **Verify:** a fresh `diff -rq` (excluding `.git`, `node_modules`, `__pycache__`) between each split repo's relevant subtree and the monorepo's current on-disk state shows no unexpected differences beyond the intentional role-scoping trims already documented in each repo's own README.

### P0 — Launch-blocking (repo mapping shown per item)

1. **Verify the AI-material bridge end-to-end via a real multi-repo `docker compose` run.** This is the core "NotebookLM" loop and the highest-risk area — it's new, and has no evidence of live testing. Stand up `lms-services-backend` + `data-processing-backend` (RAG) + `teacher-portal` + `student-portal` together (each repo's own README documents its env vars and how to point `API_PROXY_TARGET` at a shared gateway — use those). Walk the real path once: upload a PDF via `teacher-portal`'s Library page → confirm ingestion completes → publish it to a classroom chapter → confirm an enrolled `student-portal` user gets grounded AI-tutor answers from it, and a non-enrolled one is blocked. Harden `curriculum.py`'s `fetch_context` error handling (it currently collapses "RAG down" and "document not ready" into one generic message).
   - Repos: `lms-services-backend` (`services/lms/curriculum.py`, `tests/test_curriculum.py`), `data-processing-backend` (RAG), `teacher-portal` (`Library.jsx`), `student-portal` (`Workspace.jsx`)

2. **Verify (don't rebuild) the rubric-authoring UI once synced into `teacher-portal`.** Confirm end-to-end: create → attach → grade → scores compute correctly against `lms-services-backend`'s `rubrics.py`. Add a "detach rubric" route if time allows — the component's own comments note this is currently missing.
   - Repos: `teacher-portal` (`RubricField.tsx`, `ClassworkTab.jsx`), `lms-services-backend` (`rubrics.py`)

3. **Strip demo/seed data from every affected repo.** Check `data-processing-backend` (seed-data), `apis` (auth seed script), and each portal's `Login.jsx` for demo prefills/buttons. This needs a per-repo pass now, not a single monorepo pass.
   - Repos: `data-processing-backend`, `apis`, `teacher-portal`, `parent-portal`, `student-portal`

4. **Retire the legacy `frontend/index.html` ingestion form in each portal that still carries it.** It has no classroom picker and never calls the LMS linking endpoints — any upload through it is permanently inert. Since each portal repo's `frontend/` is the vanilla-PWA half extracted per role, check `teacher-portal/frontend/index.html` specifically (that's where the ingestion form would live) and remove/disable it there.
   - Repo: `teacher-portal`

5. **Decide on `services/psv` before it ships.** Already living in `intelligence-decisioning`, calling into `lms-services-backend`'s notification batch endpoint. Not part of any approved scope — this session's `db`/`intelligence-decisioning` split agents independently flagged the same thing. Default recommendation: don't deploy `psv` in the production compose for `intelligence-decisioning`; leave the dormant, token-gated endpoint alone in `lms-services-backend`.
   - Repos: `intelligence-decisioning`, `lms-services-backend`

### P1 — High-value if time allows (each independent, parallelizable, mapped to `teacher-portal` unless noted)

- **Join-code copy/regenerate UI** — `teacher-portal` (`Classroom.jsx`-equivalent), backend already supports both in `lms-services-backend`.
- **Comment edit/delete UI** — needed in **both** `teacher-portal` (moderation) and `student-portal` (edit own comment); backend (`discussions.py`) already supports both with the correct permission split — mirror it exactly per portal.
- **Guardian-invite UI** — invite/list/remove lives in `teacher-portal`; the redeem/view side already exists in `parent-portal`'s `Guardian.jsx`. UI copy must say "share this code" not "we'll email them" — no email infrastructure exists anywhere in the stack.
- **Term edit/delete UI** — `teacher-portal`, backend already supports both.
- **Fix the known 375×812 tab-bar overflow bug** — wherever `Classroom.jsx`/`index.css` landed in `teacher-portal` (and check `student-portal`/`parent-portal` for the same shared-origin CSS, since all three copied from the same source file).

### P2 — Founder decisions, not silent fixes

- **Guardian dashboard: live view vs. periodic digest email.** Recommend keeping `parent-portal`'s live dashboard for launch — no email infrastructure exists anywhere in any repo, and building one (provider, mailer, scheduler, templates, deliverability) is a multi-day project on its own. If wanted, it would hang off `lms-services-backend`'s existing `scheduler.py` job pattern.
- **Grade categories/weighting.** Doesn't exist on either side of any repo. Recommend deferring; register via the existing `capability.ts` pattern (present in every portal that copied `features/shared/`).
- **Mute-student.** Doesn't exist anywhere. Recommend deferring.

## Execution order

1. Step 0 (re-sync + freeze monorepo development) — sequential, blocks everything.
2. Two parallel tracks once synced: **Track A** (`lms-services-backend` + `data-processing-backend`) — verify AI-material bridge → strip demo/seed → decide on `psv`. **Track B** (portal repos) — verify rubric UI in `teacher-portal`, then P1 items in parallel across `teacher-portal`/`parent-portal`/`student-portal` (each portal's own copy of shared components means these genuinely don't conflict).
3. Run the AI-material-bridge docker-compose verification *last* within Track A, after demo/seed stripping, against the multi-repo environment that will actually ship.
4. P2 items are founder-blocking, not engineering-blocking — flag and move on.

## Verification

- **Re-sync (Step 0)**: `diff -rq` each split repo's relevant subtree against current monorepo state — no unexpected drift beyond documented role-scoping.
- **AI-material bridge**: manual multi-repo docker-compose walkthrough — no automated test currently exercises the real cross-service HTTP round-trip.
- **Demo/seed removal**: fresh multi-repo `docker compose up` from clean `.env`s produces zero demo accounts across the stack.
- **Portal UI additions** (P1): manual pass per item per portal, exercising both the happy path and the permission boundary the backend already enforces.
- **CSS fix**: load the classroom page at 375×812 in both themes in each affected portal, confirm `document.body.scrollWidth === window.innerWidth`.
