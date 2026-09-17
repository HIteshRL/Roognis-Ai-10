"""Durable ingestion worker: queue rows and files are committed before HTTP acceptance.

The row lock is held in a transaction during processing. A terminated worker
rolls back and releases the lock, leaving the upload available for another worker.
"""
import logging
import signal
import time
from sqlalchemy import select
from database import SessionLocal, init_db
from config import get_settings
from models import Document, DocumentIngestionJob, DocumentStatus, IngestionJobStatus
from eke_pipeline import run_entity_extraction
from chunking import generate_chunks_and_embeddings

logger = logging.getLogger(__name__)
stop = False

def run_one():
    with SessionLocal() as db:
        job = db.scalar(select(DocumentIngestionJob).where(
            DocumentIngestionJob.status == IngestionJobStatus.QUEUED.value
        ).order_by(DocumentIngestionJob.created_at).with_for_update(skip_locked=True).limit(1))
        if not job:
            return False
        document = db.get(Document, job.document_id)
        if not document:
            job.status = IngestionJobStatus.FAILED.value
            job.error_message = "Source file record is missing."
            db.commit()
            return True
        try:
            run_entity_extraction(db, document, job)
            generate_chunks_and_embeddings(db, document, job, get_settings())
            db.commit()
        except Exception:
            logger.exception("Ingestion failed for %s", document.id)
            db.rollback()
            document = db.get(Document, document.id)
            job = db.get(DocumentIngestionJob, job.id)
            document.status = DocumentStatus.FAILED.value
            document.error_message = "The document could not be processed. Check the PDF and retry."
            job.status = IngestionJobStatus.FAILED.value
            job.stage = DocumentStatus.FAILED.value
            job.error_message = document.error_message
            db.commit()
            return True
        from main import notify_quiz_service_chapter_ready, publish_curriculum_content
        notify_quiz_service_chapter_ready(db, document, get_settings())
        publish_curriculum_content(db, document, get_settings())
        return True

def shutdown(*_):
    global stop
    stop = True

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    init_db()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    while not stop:
        try:
            if not run_one(): time.sleep(1)
        except Exception:
            logger.exception("Ingestion worker iteration failed")
            time.sleep(3)
