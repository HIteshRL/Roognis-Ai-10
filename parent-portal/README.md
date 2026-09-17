# Roognis — Parent Portal

Standalone extraction of the **parent-facing** surface from the
`roognis-product` monorepo. It exists because that monorepo serves three
very different roles (student, teacher, parent) out of one 10,000+ line
single-file PWA (`frontend/index.html`) plus a secondary React app (`web/`);
this repo pulls out only what a parent account can reach, so it can be
built, deployed and iterated on independently of the student/teacher
surfaces.

Parent is by far the smallest of the three roles (CLAUDE.md in the source
repo puts it at roughly 5% of the vanilla frontend's CSS and 4% of its JS),
so most of what is in this repo is **shared/infrastructure code** — auth,
navigation, theming, the app shell — plus a comparatively small
parent-specific slice on top of it.

This repo is **frontend-only**. No `services/*` backend code was copied; both
apps below are API clients that expect the existing Roognis backend gateway
(Traefik + the Node/FastAPI services) to be reachable at whatever host
`API_PROXY_TARGET` points to.

## The two apps in this repo

Mirroring the source monorepo's own "two-frontends" split:

- **`frontend/`** — the vanilla single-file PWA, trimmed to the parent role.
  Serves the "Family learning report" dashboard (streak, time spent, quiz
  status, an academic picture, a next-step action plan, a schoolwork
  snapshot, linked children, recent activity) plus the shared Profile
  (appearance/theme) screen. This is the primary, production-shaped parent
  surface — analytics/reporting-service backed.
- **`web/`** — the React/Vite classroom app, trimmed to the three routes a
  `parent` role can reach under its own `ROUTE_POLICY`: `/guardian` (a
  read-only "family view" of a linked child's LMS coursework — upcoming
  work, missing work, returned grades), `/notifications`, and `/settings`.
  This is a second, LMS-backed parent view that already existed
  role-gated inside the classroom app; nothing here is newly written.

Both apps are legitimate, separately-live parent surfaces in the source
product — they talk to different backend services (see below) and were kept
side by side rather than merged, matching how the source repo keeps them
separate.

## What was extracted, and how

### `frontend/index.html` (12,056 → 6,250 lines)

The file has three parts: one `<style>` block, a tiny inline theme-flash
script in `<head>`, and one large `<script>` block after the body markup.
Role boundaries in the markup are marked by `<section class="view" id="...">`
— `student-mvp`, `student-discover`, `student-tutor`, `teacher-mvp`,
`teacher-ingestion`, `teacher-quizzes` were removed entirely; `parent-mvp`
and the shared `profile` section were kept, along with the auth screen,
onboarding screen, and the app shell (sidebar/nav/topbar/glass-sheet modal)
that every role uses.

The JS is ~6,500 lines of top-level function declarations in one script,
not a module system, so "what a function needs" had to be checked by
grepping every call site rather than trusting file layout. Kept: all shared
infra (icon paths, `roleConfig`/`routeMeta`/`defaultUsers`, `state`, auth
helpers, `apiJson`, nav/route/back-stack management, onboarding,
appearance/theme, `renderProfile`, the "liquid glass" scroll/press motion
effects, the glass-sheet modal, notifications) plus every function the
parent dashboard actually calls (`loadParentDashboard`, `loadLinkedChildren`,
`renderParentAcademicSummary`, `renderParentActionPlan`,
`renderParentCoursework`, `renderParentLimitations`,
`applyParentActivityDashboard`, and the three renderers it shares with
student/teacher — `renderProgressList`, `renderWeakAreas`,
`renderRecentActivity`). Removed: the tutor chat/PDF-reader/quiz-taking
block, teacher ingestion/quiz-authoring/quiz-scoring, Discover feed +
interest graph, generated visuals, instant practice, and video
recommendations — none of which the parent role's markup or data loaders
ever reference.

Three small, deliberate edits were needed to keep the trimmed file from
throwing at runtime (all commented in place):

- `setRole()` and `logoutCurrentUser()` both called `disposePdfReader()`
  unconditionally on every login/logout/role-switch; that function lived in
  the removed PDF-reader block, so the two call sites were dropped.
- `logoutCurrentUser()` wrote to `#session-pill`, which only existed in the
  removed student-tutor chat header; the write is now guarded
  (`?.replaceChildren()`).
- `setRole()`'s post-login data-loading branch called
  `loadStudentLessons`/`loadTeacherDashboard`/etc.; those branches were
  removed, leaving only the `role === 'parent'` branch (still role-checked,
  not made unconditional, so an unexpected role loads nothing instead of
  throwing).

Everything else — including a handful of functions/data objects that are
technically student- or teacher-shaped (`roleConfig.student`,
`showTutorPane`, `showTeacherPane`, the tutor/class "module rail" pane
switchers, and a startStudentActivityTracking() block that self-gates on
`state.role === 'student'`) — was **kept rather than surgically removed**,
because every one of them is either reached only through an
optional-chained (`?.`) listener on a DOM id that no longer exists (so it's
provably dead code, never a `ReferenceError`), or is itself a safe no-op for
any non-student/teacher role. This was a deliberate judgment call: the
extraction task explicitly prioritized "complete and working" over a
minimal diff, and it is much lower-risk to leave a few hundred lines of
inert, unreachable code in place than to hand-edit a shared function like
`setRole` more than strictly necessary.

**CSS was not trimmed.** The task's instruction was "when in doubt, keep —
false negatives break layout," and the `<style>` block turned out not to be
cleanly separable: role-specific sections (Discover feed, interest graph,
generated visuals, instant practice, teacher module panes) are interleaved
with shared ones inside the *same* `@media (max-width: 760px)` blocks — for
example the mobile sidebar/bottom-nav rules (including the rule that
centers a single nav tab, which is exactly what the parent role's one-item
nav needs) sit between two Discover-only media queries. Cutting mid-block
risked breaking DESIGN.md's cascade-order invariants for a few hundred KB
of saved space. All ~4,130 lines of CSS were kept as-is; unused selectors
for removed markup are inert (they match nothing) and cost nothing but
bytes.

Verified: both `<script>` blocks parse (`new Function(...)`, per the
project's own frontend test command), CSS braces balance (969/969), and
every `id="..."` referenced by the kept JS via a non-optional-chained
`querySelector('#...')` exists in the kept markup.

### `web/` (React/Vite)

`web/src/app/routePolicy.ts` is the source of truth for what a role can
reach (`ROUTE_POLICY`, `canAccessRoute`, `NAVIGATION`) and was kept
**whole** (all three roles), same reasoning as `frontend/`'s `roleConfig` —
it's small, it's the thing the shared `RoleGate` component in `App.tsx`
checks against, and `AppShell.jsx` already has an explicit `role ===
"parent"` branch for its mobile nav, so parent was already a first-class
role in this app, not something bolted on. `App.tsx` itself was trimmed to
register only the three routes `ROUTE_POLICY` grants a parent:
`/guardian`, `/notifications`, `/settings` (the latter two are shared with
student/teacher in the policy, and the policy object stayed unmodified).

Everything under `features/shared/` and `features/workflows/` was copied in
whole rather than pruned function-by-function: both are hard, direct
dependencies of the always-mounted `AppShell` (which renders
`<QuickActionModal />` unconditionally for every role — it already
self-gates for parent via `useClassrooms()` returning `[]` when
`role === 'parent'`, with a comment in the source noting exactly this), and
pruning either directory risked the same kind of cross-file breakage the
`frontend/index.html` extraction had to work around by hand. `pages/Guardian.jsx`,
`features/notifications/pages/NotificationsPage.tsx`,
`features/learning/Settings.jsx` (+ its local `features/learning/shared.jsx`
helper and `features/learning/product.css`, which carries the
`.guardian-*`/`.appearance-*`/notification styling) are the only
route-level pages kept. Not copied: `features/dashboard`, `features/timeline`,
`features/interventions`, `features/ai-inbox`, `features/grading`,
`features/calendar`, `features/todo`, `pages/Classroom*.jsx`,
`pages/CourseworkDetail.jsx` — all of these are gated to `student`/`teacher`
(or `CLASSROOM_ROLES`) in `ROUTE_POLICY` and are unreachable for `parent`.

Verified: every relative import in the copied `web/src` tree resolves to a
file that was actually copied (checked with a small script, 113 imports, 0
missing); every bare-package import (`react`, `react-dom/client`,
`react-router-dom`, `vitest`) is already a dependency in `package.json`.
Not run: `npm install` / `vitest` / `tsc --noEmit` themselves (no network
install was attempted in this extraction session) — do that as your first
step before trusting a deploy.

`package.json` and `package-lock.json` were copied **byte-for-byte**
(only the `description` field was edited afterward, which plays no part
in `npm ci`'s lockfile-integrity check) rather than pruning the now-unused
`pdfjs-dist` dependency (it was only imported by the removed
`features/learning/Workspace.jsx`, the student PDF reader). CLAUDE.md's own
"Gotchas" section warns that `npm ci` silently no-ops without a lockfile
that matches `package.json`, and a mismatched one produces confusing
"Cannot find module" failures — editing dependencies without regenerating
the lockfile (which this session could not do without a network install)
was judged the higher-risk move. Removing `pdfjs-dist` later is a safe,
optional cleanup.

## API dependencies

Both apps are pure API clients; no backend logic lives in this repo. `grep`
of the code actually kept (not the original monorepo) turns up:

**`frontend/`** (proxied through `frontend/server.js`'s `/api/*` passthrough):
- `/api/auth/{login,logout,me}` — session
- `/api/auth/parent/:userId/students` — linked children
- `/api/reporting/v1/parent/students/:studentId` — the primary family
  learning report (academic summary, action plan, coursework, limitations)
- `/api/analytics/parent/dashboard?studentId=` — fallback activity dashboard
  used if the reporting service call fails, and the source of the
  streak/time/course-progress/weak-areas panels
- `/api/ai/onboarding*` — present in the kept shared auth/onboarding code,
  but **never reached in practice**: the onboarding flow is only entered
  for `role === 'student'` (`continueAfterAuthentication`'s early return),
  which a parent-only deployment should never see from its auth backend.
- `/api/analytics/student/activity` — same situation: present in the kept
  activity-tracking helpers (kept rather than removed, see above), but
  self-gated on `state.role === 'student'` and so never actually called.

**`web/`** (proxied through `web/server.js`'s `/api/*` passthrough):
- `/api/auth/{login,logout,me}` — session
- `/api/lms/guardian/students` and
  `/api/lms/guardian/students/:studentId/summary` — the Guardian page's
  upcoming/missing/returned-grades report
- `/api/lms/notifications*` — the notification bell and `/notifications` page
- Everything else `features/shared/services/lmsService.ts` exports
  (classrooms, coursework, grading, announcements, calendar, teacher/student
  todo, AI lesson/worksheet generation via `features/workflows`) is present
  in the kept `features/shared` and `features/workflows` code (see "What was
  extracted" above for why those directories were kept whole) but is
  **unreachable for a parent role** — every route that would call it is
  blocked by `RoleGate`, and the one always-mounted exception
  (`QuickActionModal`, via `AppShell`) self-gates to an empty classroom list
  for `role === 'parent'` before any of those calls would fire. Documented
  here for completeness, not because a parent deployment should expect
  traffic on them.

Point `API_PROXY_TARGET` (or `NEXT_PUBLIC_API_URL`, the fallback both
servers accept) at a host that fronts the real Roognis backend gateway —
i.e. wherever `services/auth`, `services/analytics`, `services/reporting`,
and (for `web/`) `services/lms` are reachable, typically Traefik in front of
the full `roognis-product` stack.

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

## Running it

There is no single docker-compose in this repo (the source monorepo's own
`docker-compose.yml`, at the point this was extracted, no longer had a
`frontend` service block to model one on — see "A note on source drift"
below) — each app is a standalone Node server around a static bundle:

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

Both `Dockerfile`s were carried over unmodified (`frontend/`'s is a plain
`npm ci --omit=dev` + `node server.js`; `web/`'s is a two-stage
`npm ci && npm run build` then a slim runtime image) and both still
`EXPOSE 3000`. Put a reverse proxy in front of whichever one (or both) you
deploy, matching the `PathPrefix` pattern the source monorepo's Traefik
config uses for `frontend`/`web` today.

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
and is still the file this repo's `frontend/` app was extracted from,
per the extraction instructions. Confirm current intent in the source repo
before treating this repo's `frontend/` half as the "real" parent surface
over `web/`'s `/guardian` page, or vice versa.

## What wasn't touched

No `services/*` backend code, no database schema/migrations, no other
`milestones/` content. The source repo (`roognis-product`) was read-only for
this extraction — nothing there was modified.

## Resync note (2026-09-17)

Brought current against `roognis-product`'s on-disk state (git HEAD
`6b1d421`, itself diverged from the branch this repo was originally split
from — see below). Re-diffed `web/src` and `frontend/index.html` file by
file and re-applied the same role-scoping judgment calls documented above
to whatever had changed upstream.

**Pulled in:**

- `web/src/pages/Guardian.jsx` — a new `LinkChildCard` component and its
  "Link a child" form, backing the new guardian-redeemable-code flow
  (`services/lms/alembic/versions/0020_guardian_redeemable_code.py`,
  `guardians.py`'s `redeem_guardian_code`). Entirely parent-relevant (a
  parent redeeming a code a teacher shared with them), so copied in
  whole rather than merged piecemeal.
- `web/src/features/shared/services/lmsService.ts` — re-copied whole
  (confirmed, per the check this doc already flagged: it was copied whole
  at extraction time, not trimmed). Brings in `redeemGuardianCode` (used by
  the above) plus, as unreachable-but-present dead weight matching the
  existing pattern for classrooms/coursework/grading, the teacher-only
  guardian-management calls (`inviteGuardian`, `regenerateGuardianCode`,
  `removeGuardian`, `listStudentGuardians`) and unrelated new rubric/topic
  authoring calls — none of which a `parent` role's `RoleGate`-protected
  routes can ever reach.
- `web/src/features/shared/types/lms.ts` — re-copied whole for the same
  reason; adds the `Guardian` (now with `code`/`codeExpiresAt`/
  `codeExpired`), `Rubric`, and `Topic` interfaces `lmsService.ts` now
  imports.
- `web/src/features/shared/services/__tests__/fixtures.ts` — trivial
  `isLate: false` field addition to a shared submission fixture.
- `web/src/features/learning/product.css` — the `.guardian-link-card`/
  `.guardian-link-form` rules the new "Link a child" card needs.
- `web/src/pages/Login.jsx` and `web/src/index.css` — re-copied whole.
  These turned out **not** to need a manual role-trim (unlike the sibling
  teacher-portal's `Login.jsx`, which reportedly did): the only delta was
  upstream removing a "Demo access" quick-login panel (`DEMO_PASSWORD`,
  a `ROLES` picker with one-click buttons for each seeded demo account,
  and its `.login-role-*`/`.login-demo-*` CSS) that had briefly existed on
  a since-abandoned branch. That panel covered all three roles, not just
  parent, so there was nothing role-specific to preserve — resyncing
  means parent-portal sign-in loses the "Continue as Guardian (demo)"
  shortcut and falls back to typing `parent1@demo.com` / `demo1234` into
  the ordinary form, matching current upstream behavior exactly.

**Skipped (confirmed not parent-reachable under `ROUTE_POLICY`, unchanged):**
`features/{dashboard,timeline,interventions,ai-inbox,grading,calendar,todo}`,
the rest of `features/learning/*` (`Today.jsx`, `Learn.jsx`, `Workspace.jsx`,
`Discover.jsx`, `Onboarding.jsx`, etc. — student-only), `pages/Classroom*.jsx`,
`pages/CourseworkDetail.jsx`, `pages/tabs/*` (People/Classwork/Grades tabs,
used only by `Classroom.jsx`).

**Not changed:** `App.tsx` (still the parent-portal's own 3-route trim;
the routes it does register — `/guardian`, `/notifications`, `/settings` —
are byte-identical to upstream), `routePolicy.ts`, `AppShell.jsx`,
`components/ui.jsx`, and all of `frontend/index.html`. Every parent-relevant
function, shared data object (`roleConfig`/`routeMeta`/`defaultUsers`/
`state`), and markup section in `frontend/index.html` was diffed
individually against upstream (not just byte-compared, since a subset file
never byte-matches its source) and found unchanged since the original
extraction — the vanilla PWA side of this repo needed no resync at all
this round.

**A further note on source drift**, compounding the one already recorded
above: upstream's git history is not linear across this gap. The commit
this repo was split from corresponds to a branch (`1037051`, "Integrate
LMS services and expressive web experience") that current upstream `main`
does not contain — `main`'s current tip (`6b1d421`) instead branches
directly from that branch's own parent (`ce08c39`) and layers a differently
authored "Cleanup" commit on top. Some `1037051` work (the richer
`Login.jsx` signup flow) survived into `6b1d421` in near-identical form
regardless; the demo-picker panel did not. Treat "current" as "current
on-disk `main`," not as a linear descendant of this repo's own split
point — a future resync should keep re-diffing files directly rather than
assuming upstream history stayed on one line.

Verified after resync: both `frontend/index.html` `<script>` blocks parse,
its CSS braces still balance at 969/969 (unchanged file, unchanged count),
and all 161 relative imports across the updated `web/src` tree resolve to
files actually present in the tree.
