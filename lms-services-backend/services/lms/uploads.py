"""Real file attachment uploads — Sprint 2, P2 / D5.

Classroom/coursework/announcement attachments (`Attachment` in schemas.py)
have always been `{type: "file"|"link", url, title}` — but until now, a
"file" entry's `url` was just typed in by the teacher like a link, backed
by nothing (`0004_coursework_attachments_shape.py` only normalized the
*shape*). This module is what actually stores the bytes: upload once here,
get back a real `url`, put it in the same JSON list a "link" attachment
already used.

Storage is the shared `file_storage` Compose volume `services/rag` and
`services/ai` already mount at `/app/storage` — no new volume, one more
service-namespaced subdirectory (`lms/uploads/`), matching
`save_upload_file`'s pattern in `services/rag/main.py`. Object storage is a
separate, later conversation (no demonstrated scaling trigger yet).

Validation is a real AND, not `services/rag`'s known-risk shape (an
extension check OR'd with a content-type check, so either one alone
passes) — actually, re-checked 2026-09-01 while writing this: that
function's boolean logic already reads as a correct AND today
(`not A or not B` rejects unless both hold), so whatever this was written
against seems to have been fixed without `CLAUDE.md`'s "known live risks"
entry #13 being updated. Named here rather than silently carried forward;
`CLAUDE.md` should be corrected in the same change. Regardless of that
service's current state, this module validates independently: a file's
extension must resolve to one of `ALLOWED_UPLOADS`, and its declared
Content-Type must be in *that specific extension's* accepted set (plus the
universal `application/octet-stream` fallback some browsers send for less
common types) — correlated per-extension, not two unrelated allow-lists
each satisfiable alone.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import AuthUser, get_current_user, require_teacher
from config import Settings, get_settings
from database import get_db
from models import Upload, new_uuid

router = APIRouter(prefix="/api/lms", tags=["uploads"])

# Extension -> accepted Content-Type values. Covers what a Google-Classroom-
# style attachment realistically is: worksheets/handouts (PDF, Office docs,
# plain text) and images. Video/audio deliberately excluded — nothing in
# this app plays them, and they would blow past lms_max_upload_mb anyway.
ALLOWED_UPLOADS: dict[str, frozenset[str]] = {
    ".pdf": frozenset({"application/pdf"}),
    ".png": frozenset({"image/png"}),
    ".jpg": frozenset({"image/jpeg"}),
    ".jpeg": frozenset({"image/jpeg"}),
    ".gif": frozenset({"image/gif"}),
    ".webp": frozenset({"image/webp"}),
    ".txt": frozenset({"text/plain"}),
    ".doc": frozenset({"application/msword"}),
    ".docx": frozenset({"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}),
    ".ppt": frozenset({"application/vnd.ms-powerpoint"}),
    ".pptx": frozenset({"application/vnd.openxmlformats-officedocument.presentationml.presentation"}),
    ".xls": frozenset({"application/vnd.ms-excel"}),
    ".xlsx": frozenset({"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),
}
# Several browsers/OSes report this for less-common Office/image types
# instead of the specific MIME type. Accepted as a fallback for every
# extension above, never on its own — the extension check still applies.
_GENERIC_CONTENT_TYPE = "application/octet-stream"


def safe_filename(filename: str) -> str:
    candidate = Path(filename).name
    candidate = re.sub(r"[^A-Za-z0-9._-]+", "_", candidate).strip("._")
    return candidate or "attachment"


def validate_upload(file: UploadFile) -> str:
    """Returns the validated lowercase extension (with dot), or raises."""
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()
    accepted = ALLOWED_UPLOADS.get(ext)
    content_type = file.content_type or ""
    if not accepted or content_type not in (accepted | {_GENERIC_CONTENT_TYPE}):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type. Allowed: {', '.join(sorted(ALLOWED_UPLOADS))}.",
        )
    return ext


def save_upload_file(file: UploadFile, upload_id: str, ext: str, settings: Settings) -> tuple[str, str, int]:
    """Streams to a temp path in the same directory as the eventual
    destination — same filesystem, so the caller's later `os.replace` is a
    single rename syscall, not a copy. Returns (temp_path, final_path,
    size_bytes); the caller is responsible for the DB row landing before the
    rename (see create_upload)."""
    upload_dir = Path(settings.file_storage_path) / "lms" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    final_path = upload_dir / f"{upload_id}{ext}"
    temp_path = upload_dir / f".{upload_id}{ext}.part"
    max_bytes = settings.lms_max_upload_mb * 1024 * 1024
    total_bytes = 0

    file.file.seek(0)
    with temp_path.open("wb") as output:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                output.close()
                temp_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Upload exceeds {settings.lms_max_upload_mb} MB.",
                )
            output.write(chunk)

    if total_bytes == 0:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")

    return str(temp_path), str(final_path), total_bytes


def serialize_upload_attachment(upload: Upload) -> dict:
    """Matches schemas.Attachment's `{type, url, title}` shape exactly, so
    the client can drop this straight into a coursework/announcement's
    `attachments` list the same way a link attachment already worked."""
    return {"type": "file", "url": f"/api/lms/uploads/{upload.id}", "title": upload.original_filename}


@router.post("/uploads", status_code=status.HTTP_201_CREATED)
def create_upload(
    file: UploadFile = File(...),
    user: AuthUser = Depends(require_teacher),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    ext = validate_upload(file)
    original_filename = safe_filename(file.filename or f"attachment{ext}")
    upload_id = new_uuid()

    # Order matters, and used to be backwards: INSERT+flush, *then* stream up
    # to 20 MB to disk, *then* commit. That opened two problems — a failed
    # commit orphaned a fully-written file on the shared file_storage volume
    # with no reaper, and the flush-opened transaction held one of only five
    # pooled DB connections for the entire streamed write, so a handful of
    # concurrent slow uploads could starve every other LMS request. Writing
    # first means a failed write never touches the database at all, and the
    # one DB transaction here is just the INSERT.
    temp_path, final_path, size_bytes = save_upload_file(file, upload_id, ext, settings)

    try:
        upload = Upload(
            id=upload_id,
            school_id=user.school_id,
            uploaded_by=user.user_id,
            original_filename=original_filename,
            content_type=file.content_type or "application/octet-stream",
            size_bytes=size_bytes,
            storage_path=final_path,
        )
        db.add(upload)
        db.commit()
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise
    db.refresh(upload)

    # The row is now durable and already points at `final_path`; make the
    # bytes visible under that name. Same directory as the temp file, so this
    # is one rename syscall. If this step itself fails, the row is left
    # pointing at a path with no file yet — a narrower, rarer residual than
    # the orphaned-file problem this reordering removes, and self-evident on
    # the next GET (a clean 404, not a 500) rather than silent.
    os.replace(temp_path, final_path)

    return serialize_upload_attachment(upload)


@router.get("/uploads/{upload_id}")
def get_upload(
    upload_id: str,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # School-scoped, not classroom-scoped (see module docstring): an upload
    # isn't tied to one classroom, but must never cross a school boundary —
    # the same tenancy rule every other school-scoped read in this service
    # enforces.
    upload = db.scalar(select(Upload).where(Upload.id == upload_id))
    if not upload or upload.school_id != user.school_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found.")
    file_path = Path(upload.storage_path)
    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found.")
    return FileResponse(
        path=file_path,
        media_type=upload.content_type,
        filename=upload.original_filename,
    )
