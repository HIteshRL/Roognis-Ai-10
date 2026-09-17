# ─────────────────────────────────────────────────────────────────────────────
# Roognis AI — LMS / Classroom Service  (:3006, schema: lms_db)
#
# A Google-Classroom-style teaching layer ported from Roognis v2's `learner`
# service into main4's microservice conventions (FastAPI + SQLAlchemy + cookie
# JWT + internal-token, mirroring services/rag). Owns classrooms, chapters,
# enrollment, coursework, submissions, and grading. Identity (users/schools) is
# owned by the Auth Service; this service scopes everything by the JWT's
# schoolId + userId and never reaches across schemas.
# ─────────────────────────────────────────────────────────────────────────────
import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, status
from sqlalchemy.orm import Session

import classrooms as cr
import coursework as cw
import membership as mem
from auth import (
    AuthUser,
    get_current_user,
    require_internal_token,
    require_student,
    require_teacher,
)
from clients import fire_analytics_event, fire_analytics_events
from config import Settings, get_settings
from database import get_db, init_db
from models import CourseworkTargetMode, EnrollmentRole
from schemas import (
    BulkGradeRequest,
    CreateChapterRequest,
    CreateClassroomRequest,
    CreateCourseworkRequest,
    DuplicateCourseworkRequest,
    GradeRequest,
    JoinCodeSettingRequest,
    JoinRequest,
    LinkQuizRequest,
    PublishCourseworkRequest,
    QuizScoreRequest,
    SubmitRequest,
    UpdateChapterRequest,
    UpdateClassroomRequest,
    UpdateCourseworkRequest,
)

# Google-Classroom parity routers (ported from v2 learner). Each mounts under
# /api/lms; kept as APIRouter modules so this file stays focused on the core
# classroom / coursework / submission flow.
import calendar_view
import co_teachers
import discussions
import gradebook
import groups
import guardians
import notifications
import roster_ops
import rubrics
import scheduler
import stream
import student_invitations
import terms
import todo
import topics
import uploads
import curriculum

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    settings = get_settings()
    # Disabled under lms_test_mode (set by tests/conftest.py) so pytest runs
    # never spin up an orphaned background task against the in-memory test
    # database.
    sweep_task = (
        asyncio.create_task(scheduler.run_forever(settings.lms_notification_sweep_interval_seconds))
        if not settings.lms_test_mode
        else None
    )
    yield
    if sweep_task is not None:
        sweep_task.cancel()
        with suppress(asyncio.CancelledError):
            await sweep_task


app = FastAPI(title="Roognis LMS Service", lifespan=lifespan)
app.state.settings = get_settings()

# Mount the Google-Classroom parity feature routers (stream, discussions,
# topics, rubrics, gradebook, calendar, guardians, notifications, todo).
for _feature in (
    stream, discussions, topics, rubrics, gradebook, calendar_view, guardians, notifications, co_teachers, todo,
    terms, student_invitations, uploads, groups, roster_ops, curriculum,
):
    app.include_router(_feature.router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "lms"}


@app.get("/api/lms/health")
def api_health():
    return {"status": "ok", "service": "lms"}


# ── Teacher · classrooms ─────────────────────────────────────────────────────

@app.post("/api/lms/classrooms", status_code=status.HTTP_201_CREATED)
def create_classroom(
    body: CreateClassroomRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    classroom = cr.create_classroom(db, user, body)
    db.commit()
    db.refresh(classroom)
    fire_analytics_event(
        settings,
        {
            "type": "classroom_created",
            "schoolId": user.school_id,
            "subject": classroom.subject,
            "metadata": {"classroomId": classroom.id, "teacherId": user.user_id, "name": classroom.name},
        },
    )
    return cr.serialize_classroom(classroom, 0, 0)


@app.get("/api/lms/classrooms")
def list_classrooms(
    archived: Annotated[bool, Query()] = False,
    term_id: Annotated[str | None, Query(alias="termId")] = None,
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    classrooms = cr.list_teacher_classrooms(
        db, user, only_archived=archived, term_id=term_id, limit=limit, offset=offset
    )
    classroom_ids = [c.id for c in classrooms]
    student_counts = cr.count_students_bulk(db, classroom_ids)
    chapter_counts = cr.count_chapters_bulk(db, classroom_ids)
    return {
        "classrooms": [
            cr.serialize_classroom(c, student_counts[c.id], chapter_counts[c.id])
            for c in classrooms
        ]
    }


@app.get("/api/lms/classrooms/{classroom_id}")
def get_classroom(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    classroom = mem.require_teacher_of(db, user, classroom_id)
    return cr.serialize_classroom(
        classroom, cr.count_students(db, classroom.id), cr.count_chapters(db, classroom.id)
    )


@app.patch("/api/lms/classrooms/{classroom_id}")
def update_classroom(
    classroom_id: str,
    body: UpdateClassroomRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Configuring the class (including settings) is structural/administrative,
    # kept owner-only like delete/archive/join-code below — not a co-teacher's
    # day-to-day teaching duty.
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.update_classroom(db, classroom, body)
    db.commit()
    db.refresh(classroom)
    return cr.serialize_classroom(
        classroom, cr.count_students(db, classroom.id), cr.count_chapters(db, classroom.id)
    )


@app.delete("/api/lms/classrooms/{classroom_id}")
def delete_classroom(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Destructive — owner-only, explicitly (Sprint 1 T1.2 acceptance test).
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.soft_delete_classroom(db, classroom)
    db.commit()
    return {"ok": True, "classroomId": classroom_id}


@app.post("/api/lms/classrooms/{classroom_id}/archive")
def archive_classroom(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Administrative — changes visibility for everyone; owner-only.
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.set_archived(db, classroom, True)
    db.commit()
    db.refresh(classroom)
    return cr.serialize_classroom(
        classroom, cr.count_students(db, classroom.id), cr.count_chapters(db, classroom.id)
    )


@app.post("/api/lms/classrooms/{classroom_id}/unarchive")
def unarchive_classroom(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Administrative — owner-only, matching archive above.
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.set_archived(db, classroom, False)
    db.commit()
    db.refresh(classroom)
    return cr.serialize_classroom(
        classroom, cr.count_students(db, classroom.id), cr.count_chapters(db, classroom.id)
    )


@app.post("/api/lms/classrooms/{classroom_id}/join-code/regenerate")
def regenerate_join_code(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Security-relevant (invalidates the current code for everyone) — owner-only.
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.regenerate_join_code(db, classroom)
    db.commit()
    db.refresh(classroom)
    return {"classroomId": classroom.id, "joinCode": classroom.join_code}


@app.patch("/api/lms/classrooms/{classroom_id}/join-code")
def set_join_code_enabled(
    classroom_id: str,
    body: JoinCodeSettingRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Security-relevant — owner-only, matching regenerate above.
    classroom = mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.set_join_code_enabled(db, classroom, body.enabled)
    db.commit()
    db.refresh(classroom)
    return {"classroomId": classroom.id, "joinCodeEnabled": classroom.join_code_enabled}


# ── Teacher · roster & enrollment ────────────────────────────────────────────

@app.get("/api/lms/classrooms/{classroom_id}/students")
def list_roster(
    classroom_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    mem.require_teacher_of(db, user, classroom_id)
    enrollments = cr.list_enrollments(
        db,
        classroom_id,
        status_filter="active",
        role_filter=EnrollmentRole.STUDENT.value,
        limit=limit,
        offset=offset,
    )
    return {"students": [cr.serialize_enrollment(e) for e in enrollments]}


@app.get("/api/lms/classrooms/{classroom_id}/enrollments/pending")
def list_pending(
    classroom_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    mem.require_teacher_of(db, user, classroom_id)
    enrollments = cr.list_enrollments(
        db, classroom_id, status_filter="pending", limit=limit, offset=offset
    )
    return {"pending": [cr.serialize_enrollment(e) for e in enrollments]}


@app.post("/api/lms/classrooms/{classroom_id}/enrollments/{student_id}/approve")
def approve_enrollment(
    classroom_id: str,
    student_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    classroom = mem.require_teacher_of(db, user, classroom_id)
    cr.approve_enrollment(db, classroom_id, student_id)
    db.commit()
    fire_analytics_event(
        settings,
        {
            "type": "student_enrolled",
            "studentId": student_id,
            "schoolId": user.school_id,
            "subject": classroom.subject,
            "metadata": {"classroomId": classroom_id, "via": "approval"},
        },
    )
    return {"classroomId": classroom_id, "studentId": student_id, "status": "active"}


@app.post("/api/lms/classrooms/{classroom_id}/enrollments/{student_id}/reject")
def reject_enrollment(
    classroom_id: str,
    student_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    mem.require_teacher_of(db, user, classroom_id)
    cr.reject_enrollment(db, classroom_id, student_id)
    db.commit()
    return {"ok": True, "studentId": student_id}


@app.delete("/api/lms/classrooms/{classroom_id}/students/{student_id}")
def remove_student(
    classroom_id: str,
    student_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    # Kicking a student out is impactful enough to keep owner-only, unlike
    # approve/reject below which are onboarding-gate decisions.
    mem.require_teacher_of(db, user, classroom_id, allow_co_teacher=False)
    cr.remove_student(db, classroom_id, student_id)
    db.commit()
    return {"ok": True, "studentId": student_id}


# ── Teacher · chapters ───────────────────────────────────────────────────────

@app.post("/api/lms/classrooms/{classroom_id}/chapters", status_code=status.HTTP_201_CREATED)
def add_chapter(
    classroom_id: str,
    body: CreateChapterRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    classroom = mem.require_teacher_of(db, user, classroom_id)
    chapter = cr.add_chapter(db, classroom, body)
    db.commit()
    db.refresh(chapter)
    return cr.serialize_chapter(chapter)


@app.get("/api/lms/classrooms/{classroom_id}/chapters")
def list_chapters(
    classroom_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    mem.require_teacher_of(db, user, classroom_id)
    chapters = cr.list_chapters(db, classroom_id)
    return {"chapters": [cr.serialize_chapter(ch) for ch in chapters]}


@app.patch("/api/lms/chapters/{chapter_id}")
def update_chapter(
    chapter_id: str,
    body: UpdateChapterRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    chapter = cr.get_owned_chapter(db, user, chapter_id)
    cr.update_chapter(db, chapter, body)
    db.commit()
    db.refresh(chapter)
    return cr.serialize_chapter(chapter)


@app.delete("/api/lms/chapters/{chapter_id}")
def delete_chapter(
    chapter_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    chapter = cr.get_owned_chapter(db, user, chapter_id)
    cr.delete_chapter(db, chapter)
    db.commit()
    return {"ok": True, "chapterId": chapter_id}


# ── Teacher · coursework & grading ───────────────────────────────────────────

@app.post("/api/lms/classrooms/{classroom_id}/coursework", status_code=status.HTTP_201_CREATED)
def create_coursework(
    classroom_id: str,
    body: CreateCourseworkRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    classroom = mem.require_teacher_of(db, user, classroom_id)
    coursework = cw.create_coursework(db, user, classroom, body)
    db.commit()
    db.refresh(coursework)
    return cw.serialize_coursework(coursework, stats=cw.submission_stats(db, coursework))


@app.get("/api/lms/classrooms/{classroom_id}/coursework")
def list_classroom_coursework(
    classroom_id: str,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    mem.require_teacher_of(db, user, classroom_id)
    items = cw.list_coursework(
        db, classroom_id, status_filter=status_filter, limit=limit, offset=offset
    )
    stats_by_id = cw.submission_stats_bulk(db, items)
    return {
        "coursework": [
            cw.serialize_coursework(item, stats=stats_by_id[item.id])
            for item in items
        ]
    }


@app.get("/api/lms/coursework/{coursework_id}")
def get_coursework(
    coursework_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    return cw.serialize_coursework(coursework, stats=cw.submission_stats(db, coursework))


@app.patch("/api/lms/coursework/{coursework_id}")
def update_coursework(
    coursework_id: str,
    body: UpdateCourseworkRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    cw.update_coursework(db, coursework, body)
    db.commit()
    db.refresh(coursework)
    return cw.serialize_coursework(coursework, stats=cw.submission_stats(db, coursework))


@app.post("/api/lms/coursework/{coursework_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_coursework(
    coursework_id: str,
    body: DuplicateCourseworkRequest = DuplicateCourseworkRequest(),
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    source = cw.get_owned_coursework(db, user, coursework_id)
    duplicate = cw.duplicate_coursework(
        db, settings, user, source, target_classroom_id=body.classroom_id, title=body.title
    )
    db.commit()
    db.refresh(duplicate)
    return cw.serialize_coursework(duplicate, stats=cw.submission_stats(db, duplicate))


@app.post("/api/lms/coursework/{coursework_id}/link-quiz")
def link_quiz(
    coursework_id: str,
    body: LinkQuizRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    cw.link_quiz(db, settings, coursework, body.quiz_id)
    db.commit()
    db.refresh(coursework)
    return cw.serialize_coursework(coursework, stats=cw.submission_stats(db, coursework))


_TARGET_MODES = {mode.value for mode in CourseworkTargetMode}


@app.post("/api/lms/coursework/{coursework_id}/publish")
def publish_coursework(
    coursework_id: str,
    body: PublishCourseworkRequest = PublishCourseworkRequest(),
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    if body.target_mode not in _TARGET_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"targetMode must be one of {sorted(_TARGET_MODES)}.",
        )
    # Sprint 3, T2.1/T2.4: targets are set before the item is marked
    # published, so publish_coursework's own notify call (which reads
    # target_mode/CourseworkTarget) sees the final state, not the stale
    # pre-publish targeting.
    cw.set_targets(
        db,
        coursework,
        target_mode=body.target_mode,
        student_ids=body.student_ids,
        group_ids=body.group_ids,
    )
    cw.publish_coursework(db, coursework)
    db.commit()
    db.refresh(coursework)
    fire_analytics_event(
        settings,
        {
            "type": "coursework_published",
            "schoolId": user.school_id,
            "metadata": {
                "classroomId": coursework.classroom_id,
                "courseworkId": coursework.id,
                "type": coursework.type,
                "title": coursework.title,
            },
        },
    )
    return cw.serialize_coursework(coursework, stats=cw.submission_stats(db, coursework))


@app.get("/api/lms/coursework/{coursework_id}/submissions")
def list_submissions(
    coursework_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    # `stats` is computed over the whole roster/coursework, independent of
    # `limit`/`offset` on the page of rows returned below — pagination must
    # never change what the denominators report.
    submissions = cw.list_submissions(db, coursework.id, limit=limit, offset=offset)
    return {
        "courseworkId": coursework.id,
        "stats": cw.submission_stats(db, coursework),
        "submissions": [cw.serialize_submission(s) for s in submissions],
    }


@app.post("/api/lms/submissions/{submission_id}/grade")
def grade_submission(
    submission_id: str,
    body: GradeRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    submission, coursework = cw.get_owned_submission(db, user, submission_id)
    cw.grade_submission(db, user, submission, coursework, body)
    db.commit()
    db.refresh(submission)
    fire_analytics_event(
        settings,
        {
            "type": "coursework_graded",
            "studentId": submission.student_id,
            "schoolId": user.school_id,
            "metadata": {
                "classroomId": coursework.classroom_id,
                "courseworkId": coursework.id,
                "submissionId": submission.id,
                "grade": float(submission.grade) if submission.grade is not None else None,
                "maxPoints": float(coursework.max_points) if coursework.max_points is not None else None,
            },
        },
    )
    return cw.serialize_submission(submission)


@app.get("/api/lms/submissions/{submission_id}/grade-history")
def get_grade_history(
    submission_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Sprint 2, P3: unlike grading itself, viewing the audit trail is not
    # teacher-only — a student may see the history of their own grade. But
    # "their own grade" means the grades actually handed back to them: a
    # teacher's in-progress, not-yet-returned grade is withheld here for the
    # same reason serialize_submission withholds it (Sprint 1, T3.1).
    submission, _coursework = cw.get_viewable_submission(db, user, submission_id)
    is_own_student = submission.student_id == user.user_id
    history = cw.list_grade_history(db, submission_id, returned_only=is_own_student)
    return {"submissionId": submission_id, "history": [cw.serialize_grade_history_entry(h) for h in history]}


@app.post("/api/lms/coursework/{coursework_id}/grades")
def bulk_grade_coursework(
    coursework_id: str,
    body: BulkGradeRequest,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    # bulk_grade_submissions only ever flushes; a bad row's HTTPException
    # previously relied on get_db's finally-block db.close() to roll back
    # whatever had already flushed — correct today (verified: Session.close()
    # does roll back an open transaction), but emergent rather than local, and
    # only true as long as nothing in the call chain commits early. The
    # lazy-publish path (lifecycle.py) already does commit mid-request, so
    # that assumption is no longer uniformly true across this service. An
    # explicit rollback here makes the one-bad-row-aborts-the-whole-batch
    # guarantee this route's own responsibility instead of an artifact of
    # cleanup-on-close.
    try:
        graded = cw.bulk_grade_submissions(db, user, coursework, body.grades, body.return_to_student)
        db.commit()
    except Exception:
        db.rollback()
        raise
    # Sprint 4, P3: one re-select for the whole batch, not one `db.refresh`
    # per row — every `graded` object is already correct in the identity map
    # post-commit, so this exists only to satisfy serialize_submission's read
    # of columns SQLAlchemy may have expired on commit, in a single round-trip.
    if graded:
        from sqlalchemy import select

        from models import Submission

        db.scalars(select(Submission).where(Submission.id.in_([s.id for s in graded]))).all()
    fire_analytics_events(
        settings,
        [
            {
                "type": "coursework_graded",
                "studentId": submission.student_id,
                "schoolId": user.school_id,
                "metadata": {
                    "classroomId": coursework.classroom_id,
                    "courseworkId": coursework.id,
                    "submissionId": submission.id,
                    "grade": float(submission.grade) if submission.grade is not None else None,
                    "maxPoints": float(coursework.max_points) if coursework.max_points is not None else None,
                },
            }
            for submission in graded
        ],
    )
    return {"graded": [cw.serialize_submission(s) for s in graded]}


@app.post("/api/lms/coursework/{coursework_id}/return-all")
def return_all_coursework(
    coursework_id: str,
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    coursework = cw.get_owned_coursework(db, user, coursework_id)
    returned = cw.return_all_graded(db, user, coursework)
    db.commit()
    return {"returnedCount": len(returned), "submissionIds": [s.id for s in returned]}


# ── Student ──────────────────────────────────────────────────────────────────

@app.post("/api/lms/enrollments/join")
def join_classroom(
    body: JoinRequest,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    classroom, enrollment_status = cr.join_by_code(db, user, body.code)
    db.commit()
    if enrollment_status == "active":
        fire_analytics_event(
            settings,
            {
                "type": "student_enrolled",
                "studentId": user.user_id,
                "schoolId": user.school_id,
                "subject": classroom.subject,
                "metadata": {"classroomId": classroom.id, "via": "join_code"},
            },
        )
    return {
        "status": enrollment_status,
        "classroom": cr.serialize_student_classroom(classroom, cr.count_chapters(db, classroom.id)),
    }


@app.get("/api/lms/student/classrooms")
def student_classrooms(
    term_id: Annotated[str | None, Query(alias="termId")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    classrooms = cr.list_student_classrooms(db, user, term_id=term_id, limit=limit, offset=offset)
    chapter_counts = cr.count_chapters_bulk(db, [c.id for c in classrooms])
    return {
        "classrooms": [
            cr.serialize_student_classroom(c, chapter_counts[c.id]) for c in classrooms
        ]
    }


@app.post("/api/lms/classrooms/{classroom_id}/leave")
def leave_classroom(
    classroom_id: str,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    enrollment = cr.get_enrollment(db, classroom_id, user.user_id)
    if not enrollment:
        from fastapi import HTTPException

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="You are not enrolled in this class.")
    db.delete(enrollment)
    db.commit()
    return {"ok": True, "classroomId": classroom_id}


@app.get("/api/lms/student/classrooms/{classroom_id}/chapters")
def student_chapters(
    classroom_id: str,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    cr.require_enrolled(db, user, classroom_id)
    chapters = cr.list_chapters(db, classroom_id, published_only=True)
    return {"chapters": [cr.serialize_chapter(ch) for ch in chapters]}


@app.get("/api/lms/student/classrooms/{classroom_id}/coursework")
def student_coursework(
    classroom_id: str,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    classroom = cr.require_enrolled(db, user, classroom_id)
    items = cw.list_published_coursework(db, classroom, user.user_id)
    submission_by_id = cw.get_student_submissions_bulk(db, [item.id for item in items], user.user_id)
    return {
        "coursework": [
            cw.serialize_coursework(
                item,
                my_submission=submission_by_id.get(item.id),
                include_my_submission=True,
                for_student=True,
            )
            for item in items
        ]
    }


@app.post("/api/lms/coursework/{coursework_id}/submit", status_code=status.HTTP_201_CREATED)
def submit_coursework(
    coursework_id: str,
    body: SubmitRequest,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    coursework = cw.get_published_coursework_for_student(db, user, coursework_id)
    content = body.content or ({"text": body.text} if body.text else {})
    submission = cw.submit_coursework(db, user, coursework, content)
    db.commit()
    db.refresh(submission)
    fire_analytics_event(
        settings,
        {
            "type": "coursework_submitted",
            "studentId": user.user_id,
            "schoolId": user.school_id,
            "metadata": {
                "classroomId": coursework.classroom_id,
                "courseworkId": coursework.id,
                "submissionId": submission.id,
                "type": coursework.type,
            },
        },
    )
    return cw.serialize_submission(submission, for_student=True)


@app.post("/api/lms/coursework/{coursework_id}/save")
def save_coursework_draft(
    coursework_id: str,
    body: SubmitRequest,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    coursework = cw.get_published_coursework_for_student(db, user, coursework_id)
    content = body.content or ({"text": body.text} if body.text else {})
    submission = cw.save_draft(db, user, coursework, content)
    db.commit()
    db.refresh(submission)
    return cw.serialize_submission(submission, for_student=True)


@app.get("/api/lms/student/submissions")
def student_submissions(
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthUser = Depends(require_student),
    db: Session = Depends(get_db),
):
    submissions = cw.list_student_submissions(db, user, limit=limit, offset=offset)
    return {"submissions": [cw.serialize_submission(s, for_student=True) for s in submissions]}


# ── Internal (service-to-service) ────────────────────────────────────────────

@app.get("/api/lms/internal/enrollment")
def internal_enrollment(
    classroomId: Annotated[str, Query()],
    studentId: Annotated[str, Query()],
    _internal: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    return {
        "classroomId": classroomId,
        "studentId": studentId,
        "enrolled": cr.is_enrolled(db, classroomId, studentId),
    }


@app.get("/api/lms/internal/chapter-access")
def internal_chapter_access(
    chapterId: Annotated[str, Query()],
    studentId: Annotated[str, Query()],
    _internal: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    """Used by the AI/RAG services to scope a student's chapter chat: returns the
    chapter's knowledge-base id only when the student is enrolled and the chapter
    is published (ports v2's resolve_chapter_kb_for_student)."""
    from sqlalchemy import select

    from models import Chapter

    chapter = db.scalar(select(Chapter).where(Chapter.id == chapterId))
    if not chapter or not chapter.is_published:
        return {"allowed": False, "knowledgeBaseId": None, "classroomId": None}
    allowed = cr.is_enrolled(db, chapter.classroom_id, studentId)
    return {
        "allowed": allowed,
        "knowledgeBaseId": chapter.knowledge_base_id if allowed else None,
        "classroomId": chapter.classroom_id,
    }


@app.get("/api/lms/internal/quiz-access")
def internal_quiz_access(
    quizId: Annotated[str, Query()],
    studentId: Annotated[str, Query()],
    _internal: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    """Sprint 3, T3.2 (the quiz bridge): used by the Quiz Service to gate a
    student's access to a quiz linked to a coursework item.

    ``linked: false`` means no coursework references this quiz at all —
    the caller must leave its own pre-Sprint-3 behaviour unchanged in that
    case (decision D11). Chapter quizzes opened from ``frontend/`` are
    never linked to LMS coursework, so this route must never become a
    gate on quizzes generally, only on the ones a teacher has actually
    attached to a classroom assignment."""
    from sqlalchemy import select

    from models import Coursework, CourseworkStatus

    coursework = db.scalar(select(Coursework).where(Coursework.quiz_id == quizId))
    if not coursework:
        return {
            "linked": False,
            "allowed": False,
            "classroomId": None,
            "courseworkId": None,
            "maxPoints": None,
        }
    allowed = (
        coursework.status == CourseworkStatus.PUBLISHED.value
        and cr.is_enrolled(db, coursework.classroom_id, studentId)
        and cw.is_visible_to_student(db, coursework, studentId)
    )
    return {
        "linked": True,
        "allowed": allowed,
        "classroomId": coursework.classroom_id,
        "courseworkId": coursework.id,
        "maxPoints": float(coursework.max_points) if coursework.max_points is not None else None,
    }


@app.post("/api/lms/internal/quiz-score")
def internal_quiz_score(
    body: QuizScoreRequest,
    _internal: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
):
    """Sprint 3, T3.3: the Quiz Service posts here once
    `services/quiz/lib/scoring.js` has graded a student's attempt on a
    linked quiz. A no-op (200, `graded: false`) when the quiz isn't linked
    to any coursework, the coursework has no `maxPoints` to scale against,
    or the student wasn't actually targeted by it — never a 4xx for those
    cases, since none of them is the caller's fault to fix."""
    from sqlalchemy import select

    from models import Coursework, QuizScoreReceipt

    coursework = db.scalar(select(Coursework).where(Coursework.quiz_id == body.quiz_id).with_for_update())
    if not coursework:
        return {"graded": False, "reason": "not_linked"}

    if body.attempt_id and db.get(QuizScoreReceipt, body.attempt_id):
        return {"graded": True, "duplicate": True, "courseworkId": coursework.id}
    if body.score > body.max_score:
        raise HTTPException(422, "Score exceeds maximum score.")
    submission = cw.record_quiz_score(
        db,
        coursework,
        student_id=body.student_id,
        score=body.score,
        max_score=body.max_score,
    )
    if submission is None:
        return {"graded": False, "reason": "not_applicable"}
    if body.attempt_id:
        db.add(QuizScoreReceipt(attempt_id=body.attempt_id, coursework_id=coursework.id, student_id=body.student_id))
    db.commit()
    db.refresh(submission)
    return {
        "graded": True,
        "courseworkId": coursework.id,
        "submissionId": submission.id,
        "grade": float(submission.grade) if submission.grade is not None else None,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3006)))
