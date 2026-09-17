"""One-off backfill: add passage-level chunks to documents ingested before
passage chunking existed.

`generate_chunks_and_embeddings` deletes and recreates all chunks for a
document from its already-extracted EducationalEntity rows plus (now) the
PDF's own paragraph blocks — so this needs no re-upload, just the file still
being present at `document.file_path` on disk.

Usage (inside the rag container, so it shares the real database and storage):
    python backfill_passage_chunks.py
"""

from __future__ import annotations

from chunking import generate_chunks_and_embeddings
from config import get_settings
from database import SessionLocal
from models import Document, DocumentIngestionJob, DocumentStatus, IngestionJobStatus


def run() -> None:
    settings = get_settings()
    db = SessionLocal()
    processed = 0
    failed = 0
    try:
        documents = db.query(Document).filter(Document.status == DocumentStatus.READY.value).all()
        print(f"Found {len(documents)} ready document(s).")

        for document in documents:
            job = DocumentIngestionJob(
                document_id=document.id,
                school_id=document.school_id,
                status=IngestionJobStatus.QUEUED.value,
                stage=DocumentStatus.QUEUED.value,
                progress_percent=0,
                metadata_json={"documentStatus": DocumentStatus.QUEUED.value, "backfill": "passage_chunks"},
            )
            db.add(job)
            db.flush()

            try:
                result = generate_chunks_and_embeddings(db, document, job, settings)
                db.commit()
                processed += 1
                print(
                    f"  {document.chapter_name!r} (grade {document.grade} {document.subject}): "
                    f"{result.chunks_created} chunks total."
                )
            except Exception as exc:
                db.rollback()
                failed += 1
                print(f"  FAILED {document.id} ({document.chapter_name!r}): {exc}")

        print(f"Done: {processed} document(s) re-chunked, {failed} failed.")
    finally:
        db.close()


if __name__ == "__main__":
    run()
