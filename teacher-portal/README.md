# Roognis — Teacher Portal

Standalone extraction of the **teacher-facing** surface from the
`roognis-product` monorepo. That monorepo serves three very different roles
(student, teacher, parent) out of one 12,000+ line single-file PWA
(`frontend/index.html`) plus a secondary React app (`web/`); this repo pulls
out only what a teacher account can reach, so it can be built, deployed and
iterated on independently of the student/parent surfaces.

Teacher intelligence in this product is grounded in **analytics**, not the
LMS — per the source repo's own `CLAUDE.md`. Keep that distinction in mind
when extending this repo: teacher-facing intervention/weak-area/dashboard
views should call `/api/analytics`, not add new LMS-derived scoring logic.

This repo is **frontend-only**. No `services/*` backend code was copied;
both apps below are API clients that expect the existing Roognis backend
gateway (Traefik + the Node/FastAPI services) to be reachable at whatever
host `API_PROXY_TARGET` points to.

## The two apps in this repo

Mirroring the source monorepo's own "two-frontends" split:

- **`frontend/`** — the vanilla single-file PWA, trimmed to the teacher
  role. Serves the teacher dashboard, PDF/content ingestion (chapter
  upload), quiz authoring + the review-then-publish approval gate, and the
  teacher analytics view (weak areas, interventions, engagement), plus the
  shared Profile (appearance/theme) screen.
- **`web/`** — the React/Vite classroom app, trimmed to the routes a
  `teacher` role can reach under its own `ROUTE_POLICY`: the teacher
  dashboard, AI inbox + insight detail, student interventions, academic
  insights, review, library, classes/classroom/coursework-detail
  (classroom management — creating classes, posting work, grading), a
  calendar, notifications, and settings. This is the classroom-management
  surface `CLAUDE.md`'s "D1" note describes as promoted to first-class for
  exactly this kind of work.

Both apps are legitimate, separately-live teacher surfaces in the source
product — they talk to different backend services (see below) and were kept
side by side rather than merged, matching how the source repo keeps them
separate.

## What was extracted, and how

### `frontend/index.html` (12,056 → 7,214 lines)

Role boundaries in the markup are marked by `<section class="view" id="...">`
— `student-mvp`, `student-discover`, `student-tutor`, `parent-mvp` were
removed entirely; `teacher-mvp`, `teacher-ingestion`, `teacher-quizzes`, and
the shared `profile` section were kept, along with the auth screen,
onboarding screen, and the app shell (sidebar/nav/topbar/glass-sheet modal)
every role uses.

Kept: all shared infra (auth helpers, `apiJson`, nav/route management,
theme, the glass-sheet modal, notifications) plus every teacher-only
function — content ingestion upload flow, quiz authoring/approval UI,
teacher analytics dashboard, intervention flags, weak-areas views. Removed:
tutor chat, Discover feed + interest graph, generated visuals, instant
practice, video recommendations, and the parent report/reporting views —
none of which the teacher role's markup or data loaders reference.

Verified: both `<script>` blocks parse (`new Function(...)`), CSS braces
balance (1,600/1,600 open/close). CSS was kept in full rather than trimmed,
same reasoning as the other two portal repos in this split: role-specific
rules are interleaved with shared ones inside the same media-query blocks,
and DESIGN.md's cascade-order invariants make partial trimming higher-risk
than a few hundred KB of inert, unused selectors.

API calls found in the kept code: `/api/auth`, `/api/analytics`, `/api/ai`,
`/api/quiz`, `/api/rag` (the last one backs the ingestion/upload flow).

### `web/` (React/Vite)

`web/src/app/routePolicy.ts` (`ROUTE_POLICY`, `canAccessRoute`) was kept
whole, same reasoning as the sibling portal repos — it's the thing the
shared `RoleGate` component in `App.tsx` checks against. `App.tsx` was
trimmed to register only the routes `ROUTE_POLICY` grants a teacher (or a
route shared across `student`+`teacher`, i.e. classroom-management routes):
`/dashboard`, `/inbox`, `/inbox/:insightId`, `/interventions`,
`/academic-insights`, `/review`, `/library`, `/classes`, `/classes/:id`,
`/classes/:id/timeline`, `/classes/:id/work/:cwId`, `/calendar`,
`/notifications`, `/settings`.

`features/shared/` and `features/workflows/` were kept whole (hard,
always-mounted dependencies of `AppShell`), plus every feature folder a
kept route imports from: `dashboard`, `timeline`, `ai-inbox`,
`interventions`, `calendar`, `notifications`, `learning` (for
`AcademicInsights`/`Review`/`Library`/`Settings`), and the classroom-
management pages (`pages/Classrooms.jsx`, `pages/Classroom.jsx`,
`pages/CourseworkDetail.jsx`, `pages/ClassroomSettingsModal.jsx`). Verified
by resolving every import in `App.tsx` and `main.jsx` against the copied
tree — all resolve, none missing.

**One fix was required, not just a trim.** The copied `pages/Login.jsx`
still had its original three-role demo picker and signup form (student /
parent / teacher), including a `destinationFor()` that sent a parent-role
demo login to `/guardian` — a route that was correctly *not* imported into
this teacher-only `App.tsx`. Logging in as the parent demo account would
have hit `RoleGate`'s fallback and redirect-looped against its own home
route. Since teacher accounts are provisioned by school administrators (the
original file's own copy says so), self-service signup doesn't belong in a
teacher-only build either. `Login.jsx` was rewritten to sign-in only, with
a single teacher demo entry (`teacher@demo.com`) — see the file for the
inline comment recording why.

`node_modules`, build caches, and **7 broken self-referential symlinks**
(`app/app`, `auth/auth`, `styles/styles`, `components/components`,
`lib/lib`, `api/api`, `features/shared/shared`,
`features/notifications/notifications` — each pointing at its own parent
directory, harmless junk present in the source repo) were stripped before
committing.

Not run in this extraction: `npm install` / `vitest` / `tsc --noEmit` (no
network install was attempted). Do that as your first step before trusting
a deploy.

## API dependencies

Both apps are pure API clients; no backend logic lives in this repo.

**`frontend/`** (proxied through `frontend/server.js`'s `/api/*`
passthrough): `/api/auth`, `/api/analytics` (teacher dashboard,
interventions, weak areas — the analytics-grounded surface `CLAUDE.md`
requires), `/api/ai` (quiz drafting hooks used by the authoring flow),
`/api/quiz` (authoring, review-then-publish approval), `/api/rag`
(chapter/content ingestion upload).

**`web/`** (proxied through `web/server.js`'s `/api/*` passthrough):
everything `features/shared/services/lmsService.ts` exports — classrooms,
coursework, grading, announcements, calendar, todo — talks to `/api/lms`.
`features/shared/services/capability.ts` and `privacyGuard.ts` gate
`privacy`/`decisions`-derived features that (per the sibling
`intelligence-decisioning` repo in this split) are not yet wired up in
production — expect those capabilities to report `blocked` against a real
backend today.

Point `API_PROXY_TARGET` (or `NEXT_PUBLIC_API_URL`, the fallback both
servers accept) at a host that fronts the real Roognis backend gateway —
i.e. wherever `services/auth`, `services/analytics`, `services/ai`,
`services/quiz`, `services/rag`, and (for `web/`) `services/lms` are
reachable, typically Traefik in front of the full `roognis-product` stack.

## Environment variables

Neither app needs secrets of its own (no `JWT_SECRET`/`INTERNAL_SERVICE_TOKEN`
— the JWT cookie is issued and verified entirely by the backend services this
repo talks to). Both static servers read:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port the Node server listens on |
| `HOST` | `127.0.0.1` (`frontend/`) / `0.0.0.0` (`web/`) | bind address |
| `API_PROXY_TARGET` | `http://127.0.0.1` (`frontend/`) / `http://traefik` (`web/`) | backend gateway `/api/*` is proxied to |
| `NEXT_PUBLIC_API_URL` | — | accepted as a fallback for `API_PROXY_TARGET` by both servers (historical naming) |

`web/` additionally reads, **build-time only** (baked into the Vite bundle,
not runtime):

| Var | Default | Meaning |
|---|---|---|
| `VITE_BASE` | `/` | base path the SPA is served/built at |
| `API_TARGET` | `http://127.0.0.1:8080` | `vite dev`'s own `/api` proxy target (dev server only, unused in the production Docker image) |
| `VITE_DEMO_SCHOOL_ID` | — | demo school id the trimmed `Login.jsx` no longer needs (signup form removed), kept as a build var only for parity with the other portal repos |

## Running it

There is no single docker-compose in this repo (see "A note on source
drift" below) — each app is a standalone Node server around a static
bundle:

```bash
# frontend/ — no build step, server.js reads index.html from disk per request
cd frontend
npm ci --omit=dev
API_PROXY_TARGET=http://your-backend-gateway PORT=3000 node server.js
```

```bash
# web/ — Vite build, then the same kind of tiny proxy server
cd web
npm ci
npm run build
API_PROXY_TARGET=http://your-backend-gateway PORT=3000 node server.js
```

Both `Dockerfile`s were carried over unmodified and both still `EXPOSE
3000`. Put a reverse proxy in front of whichever one (or both) you deploy,
matching the `PathPrefix` pattern the source monorepo's Traefik config uses
for `frontend`/`web` today.

For local iteration on `frontend/index.html` without a rebuild, the source
repo's own pattern still applies here: `server.js` reads the file from disk
per request, so `docker cp frontend/index.html <container>:/app/index.html`
hot-patches a running container (not persistent past a rebuild).

## A note on source drift

This repo was extracted from the **current on-disk state** of
`roognis-product`, which had 249 uncommitted changes on top of its last
commit at the time. One relevant divergence from that repo's own
`CLAUDE.md`: the on-disk `docker-compose.yml` has **no `frontend` service
block at all** — only `web`, now routed at `PathPrefix('/')` rather than the
documented `/classroom`. Whether that means `frontend/` is mid-deprecation,
mid-migration, or the compose file is simply behind its own docs was not
this extraction's call to make; `frontend/index.html` still exists on disk
and is still the file this repo's `frontend/` app was extracted from, per
the extraction instructions. Confirm current intent in the source repo
before treating this repo's `frontend/` half as the "real" teacher surface
over `web/`'s classroom-management pages, or vice versa.

## Resync log

### 2026-09-17 — resync with roognis-product

The monorepo had kept moving since the 2026-09-16 23:04 extraction. Ground
truth was `diff -rq web/src` against the monorepo's current tree (plus a
by-section, by-function comparison of `frontend/index.html`), not a prior
partial list.

**`frontend/index.html`: no change needed.** Diffed the four kept
`<section class="view" id="...">` blocks (`teacher-mvp`, `teacher-ingestion`,
`teacher-quizzes`, `profile`) and all 18 `*Teacher*`-named functions
byte-for-byte against the monorepo's current file — identical except for the
`active` class on `teacher-mvp` (this repo's own default view, since it has
no student home to land on). Confirmed `#teacher-ingestion` is still present
and still the same disconnected upload flow (no classroom picker, no LMS
curriculum-linking calls) flagged elsewhere for later retirement — not
addressed in this pass.

**Copied in whole (additive-only upstream changes, not previously
role-trimmed):**
- `features/shared/services/lmsService.ts`, `features/shared/types/lms.ts` —
  confirmed still whole-file, unfiltered copies (this repo's own README never
  claimed otherwise for these two); the new exports are all teacher-authored
  surfaces — classwork **topics** (`listTopics`/`createTopic`/`updateTopic`/
  `deleteTopic`/`assignCourseworkTopic`), reusable **rubrics**
  (`createRubric`/`listRubrics`/`listMyRubrics`/`updateRubric`/
  `deleteRubric`/`attachRubric`), announcement **scheduling**
  (`updateAnnouncement`/`publishAnnouncement`), and a teacher-facing
  **guardian-code roster** (`listStudentGuardians`/`inviteGuardian`/
  `regenerateGuardianCode`/`removeGuardian` — a teacher generates the
  redeemable code a parent redeems; distinct from `redeemGuardianCode`
  itself, which is parent-side and unused here but harmless to carry since
  the file was never role-filtered).
- `features/grading/components/GradingScreen.tsx`, `pages/CourseworkDetail.jsx`,
  `features/shared/services/__tests__/fixtures.ts` — one new field
  (`Submission.isLate`) and its "Late" badge, both role-neutral.
- Six timeline files (`components/TimelineCard.tsx`,
  `components/TimelineComposer.tsx`, `hooks/useTimeline.ts`,
  `pages/ClassroomTimeline.tsx`, `services/timelineService.ts`,
  `types/timeline.ts`) — the announcement-scheduling feature end to end
  ("Post now" / "Edit" on a scheduled post). Teacher-gated at the call site
  (`isTeacher && ...` in `ClassroomTimeline.tsx`); nothing here changes what
  a student can see or do.
- `web/src/index.css` — upstream deleted the `.login-role-*`/
  `.login-demo-access` rules (see Login.jsx below); re-copying it whole
  keeps CSS and markup in lockstep rather than leaving orphaned selectors.
- `pages/tabs/ClassworkTab.jsx` — classwork topics (grouping, a "Manage
  topics" modal) and rubric attachment wired into the create/edit forms.
  Teacher-only management UI; the student list view is untouched.
- `pages/tabs/PeopleTab.jsx` — a new `GuardiansModal` (generate/regenerate/
  revoke a per-student guardian invite code), reachable only from the
  teacher branch of the component (`if (!isTeacher) return …` guards the
  whole file above it).

**New files, teacher-relevant, copied in:**
- `features/grading/components/RubricField.tsx` — rubric authoring
  (create/reuse/edit/delete a rubric), imported **only** by
  `ClassworkTab.jsx`. Checked whether the student-facing coursework view
  needed a counterpart: `CourseworkDetail.jsx` (shared by both roles in this
  repo) already renders `cw.rubricCriteria` read-only, unconditionally,
  above the `isTeacher` branch — that rendering was unchanged upstream and
  needed no new component. **`RubricField.tsx` itself has no student-portal
  use** — grepping the monorepo confirms it's only ever imported by
  `ClassworkTab.jsx` — so nothing to flag there.
- `features/timeline/components/AnnouncementScheduleControl.tsx`,
  `features/timeline/components/EditAnnouncementDialog.tsx` — the
  "post now / schedule for later" radio control and the edit-scheduled-post
  dialog, both used only from the teacher-only composer/timeline paths
  copied in above.

**Skipped, not teacher-relevant (verified against `routePolicy.ts`, which
is unchanged and identical in both repos):** `features/learning/{Assessment,
Discover,Learn,Onboarding,Progress,Revision,StudyVisual,Today,Workspace}.jsx`,
`client.js`, `client.test.js`, `interest-graph.{js,css}` — all reachable only
from `/today`, `/learn`, `/discover`, `/progress`, `/revision`,
`/assessment/:quizId`, every one of which `ROUTE_POLICY` grants to `student`
only. `pages/Guardian.jsx` (`/guardian`, `parent`-only). The
`features/learning/product.css` diff (a `.guardian-link-card`/
`.guardian-link-form` block) is Guardian-page-only CSS — left as-is.
`App.tsx`'s new lazy imports/routes for all of the above — left unchanged;
this repo's `App.tsx` already only registers the teacher/classroom routes.

**Manually re-trimmed, not copied verbatim: `pages/Login.jsx`.** The
monorepo's `Login.jsx` changed substantially — it grew a sign-in/sign-up
mode switch, `api.register`, a student/parent role picker, a school-id
field, and `destinationFor()` role-based routing — while also **removing**
the old "Demo access" quick-login section entirely (every role, not
role-specific). Judgment calls made rewriting this trim by hand:
- Kept sign-in only, no mode switch, no `api.register` call — the same
  reasoning as the original extraction (teacher accounts are provisioned by
  admins, and `/guardian`/`/today`-style destinations aren't imported into
  this app's routes, so any signup/demo path that could route a non-teacher
  role would dead-end in a redirect loop). This is reinforced, not
  contradicted, by the new version: its own signup role picker disables
  "Teacher" with the same "created by school administrators" copy this trim
  has always used.
- Did **not** reintroduce the old teacher-only "Continue as Teacher (demo)"
  button, even though the original extraction had kept one. Its removal
  upstream wasn't a role-scoping change (all three roles' demo entries went
  together), so this resync follows the same product decision rather than
  re-adding a feature upstream deliberately dropped. The seeded
  `teacher@demo.com` / `demo1234` credentials (root `CLAUDE.md`) still work
  through the ordinary sign-in form — only the shortcut button is gone.
- Copied `web/src/index.css` whole (see above), which drops the
  `.login-role-*`/`.login-demo-access` rules the removed button used —
  consistent with dropping the button.

Verified after resync: every relative import in `web/src` still resolves to
a real file (scripted check, not spot-checked); both `frontend/index.html`
`<script>` blocks still parse via `new Function(...)`; its `<style>` blocks
still balance (969 open / 969 close). `npm install`/`vitest`/`tsc --noEmit`
were **not** run — same as the original extraction, no network install was
attempted.

## What wasn't touched

No `services/*` backend code, no database schema/migrations, no other
`milestones/` content. The source repo (`roognis-product`) was read-only for
this extraction — nothing there was modified.
