"""Versioned curriculum bridge extending the engineer LMS without replacing its lifecycle."""
from datetime import datetime, timezone
from uuid import UUID
import json
from urllib import request, error
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from auth import AuthUser, get_current_user, require_teacher, require_internal_token
from database import get_db
from config import get_settings
from models import Chapter, CurriculumVersion, Classroom, Enrollment
from membership import require_member, require_teacher_of

router = APIRouter(prefix="/api/lms", tags=["curriculum"])

class VersionInput(BaseModel):
    documentId: UUID
    concepts: list[dict] = Field(default_factory=list, max_length=200)


def fetch_context(document_id: str, school_id: str) -> dict:
    settings = get_settings()
    if not settings.rag_service_url or not settings.internal_service_token:
        raise HTTPException(503, "Curriculum retrieval is not configured.")
    req = request.Request(settings.rag_service_url.rstrip("/") + "/api/rag/internal/chapter-context?documentIds=" + document_id,
        headers={"X-Internal-Service-Token": settings.internal_service_token})
    try:
        with request.urlopen(req, timeout=15) as res:
            result = json.load(res)
    except error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(503, "The document is not ready. Retry after ingestion completes.")
        raise HTTPException(503, "Curriculum retrieval failed on the content service. Try again shortly.")
    except (error.URLError, OSError):
        raise HTTPException(503, "Curriculum retrieval service is unreachable. Try again shortly.")
    except ValueError:
        raise HTTPException(503, "Curriculum retrieval returned an unreadable response. Try again shortly.")
    chapter = result.get("chapter") or {}
    if chapter.get("schoolId") != school_id:
        raise HTTPException(404, "Document not found.")
    if not result.get("chunks"):
        raise HTTPException(422, "The document has no indexed source passages.")
    return chapter


def serialize(row, chapter):
    return {"id": row.id, "chapterId": row.chapter_id, "classroomId": chapter.classroom_id,
        "title": chapter.title, "documentId": row.document_id, "status": row.status,
        "context": row.context, "concepts": row.concepts,
        "publishedAt": row.published_at.replace(tzinfo=timezone.utc).isoformat() if row.published_at else None}


def get_chapter(db, user, chapter_id, teacher=False):
    chapter = db.get(Chapter, chapter_id)
    if not chapter or chapter.school_id != user.school_id:
        raise HTTPException(404, "Chapter not found.")
    (require_teacher_of if teacher else require_member)(db, user, chapter.classroom_id)
    return chapter


@router.post("/chapters/{chapter_id}/versions", status_code=201)
def create_version(chapter_id: str, body: VersionInput, user: AuthUser = Depends(require_teacher), db: Session = Depends(get_db)):
    chapter = get_chapter(db, user, chapter_id, True)
    context = fetch_context(str(body.documentId), user.school_id)
    ids = [c.get("conceptId") for c in body.concepts]
    if any(not isinstance(c, str) or not c.strip() for c in ids) or len(ids) != len(set(ids)):
        raise HTTPException(422, "Each concept needs a unique conceptId.")
    row = CurriculumVersion(chapter_id=chapter.id, school_id=user.school_id, document_id=str(body.documentId), context=context, concepts=body.concepts)
    db.add(row); db.commit(); db.refresh(row)
    return serialize(row, chapter)


@router.get("/chapters/{chapter_id}/versions")
def versions(chapter_id: str, user: AuthUser = Depends(require_teacher), db: Session = Depends(get_db)):
    chapter = get_chapter(db, user, chapter_id, True)
    return {"versions": [serialize(r, chapter) for r in db.scalars(select(CurriculumVersion).where(CurriculumVersion.chapter_id == chapter.id).order_by(CurriculumVersion.created_at.desc()))]}


@router.post("/chapter-versions/{version_id}/publish")
def publish(version_id: str, user: AuthUser = Depends(require_teacher), db: Session = Depends(get_db)):
    row = db.scalar(select(CurriculumVersion).where(CurriculumVersion.id == version_id, CurriculumVersion.school_id == user.school_id).with_for_update())
    if not row: raise HTTPException(404, "Version not found.")
    chapter = get_chapter(db, user, row.chapter_id, True)
    if row.status != "published":
        fetch_context(row.document_id, user.school_id)
        row.status = "published"; row.published_at = datetime.now(timezone.utc)
        chapter.knowledge_base_id = row.document_id
        chapter.is_published = True
        db.commit()
    return serialize(row, chapter)


@router.get("/learning/catalog")
def catalog(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.role not in {"teacher", "student"}: raise HTTPException(403, "Learning content is available to class members.")
    rows = db.execute(select(CurriculumVersion, Chapter).join(Chapter, Chapter.id == CurriculumVersion.chapter_id).where(
        CurriculumVersion.school_id == user.school_id, CurriculumVersion.status == "published", Chapter.is_published.is_(True)
    ).order_by(CurriculumVersion.published_at.desc())).all()
    items=[]; seen=set()
    for row, chapter in rows:
        if chapter.id in seen: continue
        try: require_member(db, user, chapter.classroom_id)
        except HTTPException: continue
        classroom = db.get(Classroom, chapter.classroom_id)
        if classroom.is_archived or classroom.is_deleted: continue
        items.append(serialize(row, chapter)); seen.add(chapter.id)
    return {"items": items}


@router.get("/internal/document-access", dependencies=[Depends(require_internal_token)])
def document_access(documentId: str, studentId: str, schoolId: str, db: Session = Depends(get_db)):
    from membership import is_enrolled
    rows = db.execute(select(CurriculumVersion, Chapter).join(Chapter, Chapter.id == CurriculumVersion.chapter_id).where(
        CurriculumVersion.document_id == documentId, CurriculumVersion.school_id == schoolId,
        CurriculumVersion.status == "published", Chapter.is_published.is_(True))).all()
    for row, chapter in rows:
        classroom = db.get(Classroom, chapter.classroom_id)
        if not classroom.is_archived and not classroom.is_deleted and is_enrolled(db, classroom.id, studentId):
            return {"allowed": True, "chapterId": chapter.id, "versionId": row.id}
    raise HTTPException(403, "No active enrollment grants access to this document.")


@router.get("/internal/student-documents", dependencies=[Depends(require_internal_token)])
def student_documents(studentId: str, schoolId: str, db: Session = Depends(get_db)):
    ids=db.scalars(select(CurriculumVersion.document_id).join(Chapter, Chapter.id == CurriculumVersion.chapter_id)
        .join(Classroom, Classroom.id == Chapter.classroom_id).join(Enrollment, Enrollment.classroom_id == Classroom.id)
        .where(CurriculumVersion.school_id == schoolId, CurriculumVersion.status == "published",
            Chapter.is_published.is_(True), Classroom.is_archived.is_(False), Classroom.is_deleted.is_(False),
            Enrollment.student_id == studentId, Enrollment.status == "active", Enrollment.school_id == schoolId)).all()
    return {"documentIds": list(set(ids))}
