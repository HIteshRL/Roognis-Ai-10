# LMS / Classroom Service — `:3006`

A Google-Classroom-style teaching layer for Roognis, ported from Roognis v2's
`services/learner` into main4's microservice conventions (FastAPI + SQLAlchemy +
cookie-JWT, mirroring the RAG service). It gives teachers real
classroom → chapter → coursework → submission → grading workflow that main4
previously lacked.

- **Stack:** FastAPI · SQLAlchemy 2.0 · PyJWT · PostgreSQL schema `lms_db`
- **Auth:** shared `jwt` cookie `{ userId, role, schoolId }` (same contract as Auth Service)
- **Isolation:** owns only `lms_db`; user/school identity stays in `auth_db` (no cross-schema FKs)

## Data model (`lms_db`)

| Table | Purpose |
|---|---|
| `classrooms` | Teacher-owned class; join code, color, archive/soft-delete, `require_approval` setting |
| `chapters` | Ordered, publishable units under a classroom; optional `knowledge_base_id` link to RAG |
| `enrollments` | `(classroom, student)` membership — `pending` / `active` / `removed` |
| `coursework` | Assignment / quiz / question / material — `draft` → `published`, due date, max points |
| `submissions` | One per `(coursework, student)` — `turned_in` → `returned`, grade + feedback |

Every row is scoped by `school_id`; every teacher mutation is ownership-checked
against `teacher_id`; every student action is enrollment-checked.

## Endpoints (prefix `/api/lms`)

**Teacher** — classrooms (`POST/GET/PATCH/DELETE /classrooms[/{id}]`),
archive/unarchive, join-code regenerate/enable, roster
(`GET /classrooms/{id}/students`), enrollment approval
(`.../enrollments/pending`, `.../{studentId}/approve|reject`), chapters
(`POST/GET /classrooms/{id}/chapters`, `PATCH/DELETE /chapters/{id}`), coursework
(`POST/GET /classrooms/{id}/coursework`, `GET/PATCH /coursework/{id}`,
`POST /coursework/{id}/publish`), grading
(`GET /coursework/{id}/submissions`, `POST /submissions/{id}/grade`).

**Student** — `POST /enrollments/join`, `GET /student/classrooms`,
`GET /student/classrooms/{id}/chapters`, `GET /student/classrooms/{id}/coursework`,
`POST /coursework/{id}/submit`, `GET /student/submissions`,
`POST /classrooms/{id}/leave`.

**Internal** (require `X-Internal-Service-Token`) — `GET /internal/enrollment`
and `GET /internal/chapter-access` let the AI/RAG services scope a student's
chapter chat and resolve its knowledge-base id.

Analytics events (`classroom_created`, `student_enrolled`,
`coursework_published`, `coursework_submitted`, `coursework_graded`) are fired
non-blocking to the Analytics Service.

## Run

```sh
pip install -r requirements.txt
python main.py                 # serves on :3006 (or $PORT)
```

Via the stack: `docker-compose up --build lms` (Traefik routes `/api/lms`).

## Test

```sh
pip install -r requirements.txt
pytest -q                      # in-memory SQLite, no external services
```

Covers the full loop (create → join → publish → submit → grade), RBAC,
school-scoping, the approval flow, and the internal endpoints.
