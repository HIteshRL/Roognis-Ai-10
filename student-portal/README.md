# roognis-student-portal

The **student-facing** frontends of Roognis, split out of the `roognis-product`
monorepo into their own deployable repo. Backend services are **not**
included here — this repo is frontend-only and talks to backend APIs over
HTTP. See the sibling repos in this split for the services themselves.

## What's in here

The source monorepo served three roles (student / teacher / parent) from two
separate frontend apps. This repo keeps only the student-reachable code from
both:

- **`frontend/`** — the primary product. A single-file PWA
  (`frontend/index.html`), mobile-first/iOS-targeted, with a hand-rolled
  static file server + `/api/*` reverse proxy (`frontend/server.js`) and no
  build step. Talks to `/api/{ai,analytics,auth,quiz,rag,practice,discover}`.
- **`web/`** — a secondary Google-Classroom-parity React 18 + Vite app for
  classroom/coursework/gradebook features. Talks to `/api/lms` (plus
  `/api/auth`, and a couple of internal cross-service reads baked into the
  `features/shared` API layer). Built and served as a static SPA by its own
  tiny Node server (`web/server.js`).

Both apps originally also served `teacher` and `parent` roles from the same
codebase. That code was removed here; a teacher/parent portal would be its
own equivalent split from the same monorepo.

## How this was built (the split)

### `frontend/index.html`

The original file mixed all three roles' markup, CSS and JS in one ~12,000
line document, gated at runtime by `roleConfig` / `setRole()` and by
`<section class="view" id="...">` blocks keyed by route id
(`student-mvp`, `student-discover`, `student-tutor`, `teacher-mvp`,
`teacher-ingestion`, `teacher-quizzes`, `parent-mvp`, and the
shared `profile` section).

This repo's `frontend/index.html` was assembled by removing, in place
(preserving the original CSS cascade order and the style→body→script
structure — DESIGN.md documents that ordering as load-bearing for the
hot-patch `docker cp` workflow):

- **CSS**: the `.teacher-ingestion-grid` rule, the `.teacher-pane` /
  `#teacher-module-bar` rules, and the entire "Parent reporting" block
  (`.parent-report-brief`, `.parent-concept-*`, `.parent-coursework-*`, etc).
  Everything else — all shared/base styles, and anything ambiguous — was
  kept, on the instruction that false positives (unused CSS) are cheap and
  false negatives (broken layout) are not.
- **HTML**: the `teacher-mvp`, `teacher-ingestion`, `teacher-quizzes` and
  `parent-mvp` `<section>` blocks were removed. `student-mvp`,
  `student-discover`, `student-tutor`, and the shared `profile` section (theme
  settings, account/logout — explicitly shared across roles per the source
  file's own comment) were kept in full, along with the shared shell (topbar,
  bottom nav, onboarding screen, auth screen, glass-sheet modal
  infrastructure).
- **JS**: teacher-only and parent-only functions were removed by tracing
  every call site (ingestion upload/status polling, teacher quiz
  authoring/approval/scoring, the class-intelligence rule engine, the
  teacher inbox/follow-up-queue/activity-stream, `loadParentDashboard` /
  `loadLinkedChildren` and the parent report renderers). A few helpers are
  shared by name but diverge by caller — e.g. `EVENT_META` and `timeLabel`
  are used by both the teacher activity stream (removed) and the student
  activity feed (kept), so those two were kept and only their
  teacher-only neighbors (`ACTIVITY_FILTERS`, `activityGroup`,
  `renderTeacherActivity`, `dayLabel`) were removed. `roleConfig`,
  `defaultUsers`, `routeMeta` and `setRole`/`renderNav` themselves were left
  intact (they're generic role-gating infrastructure), but every call site
  that sets the active role now only ever passes `'student'` — the same
  behavior the file already had at startup and on session restore, since
  there is no remaining UI to switch roles.

  After the cut, every non-optional-chained `document.querySelector('#id')`
  and every `?.`-chained one were checked against the remaining markup —
  none reference an id that no longer exists, and the inline `<script>`
  blocks were parse-checked with `new Function(...)`. CSS `{`/`}` braces are
  balanced (898/898).

- `frontend/server.js`, `frontend/package.json` and `frontend/Dockerfile`
  were copied unchanged — they're generic (no role-specific code or paths).

**Result: `frontend/index.html` is 9,785 lines** (down from ~12,056).

### `web/`

Role access here is a real routing policy, not markup sections:
`web/src/app/routePolicy.ts` (`ROUTE_POLICY`, `canAccessRoute`) plus the
`RoleGate` component in `App.tsx`. Per that policy:

- **Student-only**: `/today`, `/learn`, `/learn/:versionId`, `/discover`,
  `/progress`, `/revision`, `/assessment/:quizId`
- **Student + teacher** (`CLASSROOM_ROLES`): `/classes`, `/classes/:id`,
  `/classes/:id/timeline`, `/classes/:id/work/:cwId`, `/calendar`
- **Any authenticated role**: `/notifications`, `/settings`
- **Teacher-only** (dropped here): `/dashboard`, `/inbox`,
  `/inbox/:insightId`, `/interventions`, `/academic-insights`, `/review`,
  `/library`
- **Parent-only** (dropped here): `/guardian`

`App.tsx` was trimmed to register only the student-reachable routes and
their lazy-loaded page components. Everything else follows from what those
pages actually import:

- `features/learning/` was kept **in full** — it's a self-contained module
  (Today, Learn, Workspace, Discover, Progress, Revision, Assessment,
  Settings, StudyVisual, Onboarding, the interest-graph force layout, and
  `product.css`) whose only external imports are `api/`, `auth/`,
  `components/`, and `app/theme`. It does include `Library.jsx`,
  `Review.jsx` and `AcademicInsights.jsx`, which — despite living in this
  folder — are gated teacher-only by `ROUTE_POLICY`; they're present on disk
  (harmless, unrouted) but **not** wired into `App.tsx`. This is a
  judgment call: the extraction instructions favored keeping
  `features/learning/` intact over hand-trimming a self-contained module for
  three files' worth of dead code.
- `features/shared/`, `features/grading/`, `features/workflows/`,
  `features/todo/`, `features/calendar/`, `features/timeline/`,
  `features/notifications/` were kept in full — each is a direct or
  transitive dependency of a student-reachable page (e.g. `CourseworkDetail`
  imports `features/grading`'s `GradingScreen`/`GradeHistoryPanel`/
  `PrivateNotes` directly, even though only the teacher-role branch inside
  `GradingScreen` renders the grading form; `AppShell` imports
  `features/workflows`' `QuickActionModal`; `Classrooms` imports
  `features/todo`'s `TodoPanel`).
- `features/dashboard/` was trimmed to just `components/CalendarMini.tsx` —
  the only piece of it `CalendarPage` actually imports. The rest
  (`TeacherDashboard` and its services/hooks) is teacher-only.
- `features/ai-inbox/` was trimmed to `services/insightRules.ts` and
  `types/insight.ts` — `features/timeline`'s `useTimeline` hook imports
  `buildInsights` from the former and the `AIInsight` type from the latter.
  The rest (the inbox pages, `InsightDrawer`/`InboxGroup`/`AIInsightCard`,
  `useAIInbox`, `insightService`) is teacher-only.
- `features/interventions/` was dropped entirely — nothing student-reachable
  imports it.
- `pages/Guardian.jsx` was dropped (parent-only route). Every other page in
  `pages/` (`Login`, `Classrooms`, `Classroom`, `CourseworkDetail`,
  `ClassroomSettingsModal`, `pages/tabs/*`) was kept — they're
  student-reachable via the classroom routes, and internally branch on role
  where teacher-only actions apply.
- `app/`, `auth/`, `api/`, `lib/`, `components/`, `src/styles/tokens.css`,
  `src/index.css` and `src/main.jsx` were kept unchanged — generic
  infrastructure with no role split.
- **`pages/Login.jsx` was edited** (the one non-mechanical change beyond
  route/import trimming): its demo-login list and the signup "account type"
  picker offered Teacher/Guardian options that would have landed on
  `/dashboard` or `/guardian` — routes that don't exist in this app anymore,
  which would have produced a redirect loop. The demo list now only offers
  "Continue as Student", the account-type picker was removed from the
  signup form (this portal only creates student accounts), and
  `destinationFor()` always returns `/classes`.

Verification performed: every relative import in `web/src` was checked to
resolve to a file that actually exists in the trimmed tree (0 missing, 105
files scanned) — this caught one real miss, `src/styles/tokens.css`
(imported by `main.jsx`, not part of any `features/` folder), which was
copied in afterward. `web/package.json`'s name/description were updated to
say "student portal" instead of "teacher & student LMS"; nothing else in
`package.json`, `vite.config.js`, or `tsconfig.json` referenced the role
split, so they were copied unchanged. `web/Dockerfile`'s comment about being
served at `/classroom` "alongside the existing frontend at /" no longer
applies standalone (no sibling frontend in this repo) — updated to say so;
the build itself (`VITE_BASE=/`) is unchanged.

## Backend dependency

This repo contains **no backend code**. At runtime:

- `frontend/` proxies `/api/*` to whatever `API_PROXY_TARGET` points at, and
  calls `/api/{ai,analytics,auth,quiz,rag,practice,discover}`. It never
  calls `/api/lms`.
- `web/` proxies `/api/*` the same way, and calls `/api/lms` and
  `/api/auth` (plus, per the monorepo's `MASTERCONTEXT.md`, some views read
  from `/api/discover` internals via `features/shared/services/lmsService`
  — check that file if a given page 404s against a backend that only
  implements LMS).

Point `API_PROXY_TARGET` (or, for the Vite dev server, `API_TARGET`) at
wherever those services are actually running — e.g. the sibling
backend-services repos from this same split, behind their own gateway, or
directly at the original monorepo's Traefik if you're running this
alongside it.

## Environment variables

| Var | Used by | Default | Notes |
|---|---|---|---|
| `PORT` | `frontend/server.js`, `web/server.js` | `3000` | |
| `HOST` | `frontend/server.js`, `web/server.js` | `127.0.0.1` (frontend), `0.0.0.0` (web) | |
| `API_PROXY_TARGET` | `frontend/server.js`, `web/server.js` | `http://127.0.0.1` (frontend), `http://traefik` (web) | Falls back to `NEXT_PUBLIC_API_URL` if set (legacy name, kept for compatibility) |
| `VITE_BASE` | `web` build (`vite.config.js`, `Dockerfile`) | `/` | Path prefix to build the SPA for. The monorepo built this at `/classroom`; standalone, `/` is correct unless you put it behind a path prefix again. |
| `API_TARGET` | `web` **Vite dev server only** (`vite.config.js`) | `http://127.0.0.1:8080` | Only used by `npm run dev`, not by the production build/server. |
| `VITE_DEMO_SCHOOL_ID` | `web` build, `pages/Login.jsx` | the monorepo's demo school id in dev, empty otherwise | Prefills the signup form's school code field for local demos. Baked in at build time (Vite). |

None of `frontend/index.html`'s JS reads environment variables directly —
it only ever calls relative `/api/*` paths, which `frontend/server.js`
proxies server-side.

## Running it

Each app is independent; run either or both.

```bash
# frontend/ — no build step
cd frontend
npm install
API_PROXY_TARGET=http://localhost:8080 PORT=3000 npm start
# → http://localhost:3000/

# web/ — Vite build + static server
cd web
npm install
npm run build
API_PROXY_TARGET=http://localhost:8080 PORT=3001 npm start
# → http://localhost:3001/
```

Or with Docker, matching the original monorepo's per-service build (each
`Dockerfile` is unchanged and self-contained):

```bash
docker build -t student-portal-frontend ./frontend
docker run -p 3000:3000 -e API_PROXY_TARGET=http://host.docker.internal:8080 student-portal-frontend

docker build -t student-portal-web ./web
docker run -p 3001:3000 -e API_PROXY_TARGET=http://host.docker.internal:8080 student-portal-web
```

The original monorepo ran both behind Traefik on one origin (`:80`), with
`frontend` at `PathPrefix('/')` and `web` at `PathPrefix('/classroom')` in
production (`docker-compose.production.yml`). **Note:** at the time of this
split, the monorepo's *development* `docker-compose.yml` had already
diverged from that — it had no `frontend` service at all, and `web` claimed
`PathPrefix('/')` instead of `/classroom`. That looked like in-progress,
uncommitted work in the source repo rather than a stable target topology, so
it wasn't carried over here; this README describes the production compose's
service shape (env vars, ports) since that one matches what
`frontend/server.js` and `web/server.js` actually expect. Put both apps
behind your own reverse proxy (or a fresh Traefik config) if you want the
single-origin `/api/*` proxying either server does on its own to line up
across both.

## Tests

`web/` has `vitest` configured (`npm test` / `npm run test:watch` from
`web/`) and a handful of `__tests__` files were carried over as part of
their owning directories (`app/__tests__`, `lib/__tests__`,
`features/*/services/__tests__`, `features/*/state/__tests__`,
`features/learning/client.test.js`). They were not re-run or re-audited as
part of this split — some may reference role-matrix behavior (e.g.
`app/__tests__/routePolicy.test.ts` tests the full `AppRole` policy,
teacher/parent rows included) that's still valid (the policy file itself
was left unchanged) but exercises routes this app no longer mounts.

`frontend/` has no test runner; parse-check its inline scripts before
shipping:

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('frontend/index.html','utf8');[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m,i)=>{new Function(m[1]);console.log('script_'+(i+1)+'=ok')})"
```
