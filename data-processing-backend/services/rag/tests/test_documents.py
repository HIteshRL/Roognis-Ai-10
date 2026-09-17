from pathlib import Path

import fitz
import pytest
from sqlalchemy import select

import main as rag_main
import worker as rag_worker
from database import SessionLocal
from main import app
from models import (
    Document,
    DocumentIngestionJob,
    DocumentStatus,
    EducationalEntity,
    EntityRelationship,
    EntityType,
    IngestionJobStatus,
    RetrievalChunk,
)


def upload_pdf(client, token_factory, run_worker=True, **overrides):
    client.cookies.set("jwt", token_factory(role="teacher", **overrides.pop("token_overrides", {})))
    data = {
        "board": "CBSE",
        "curriculum": "NCERT",
        "grade": "8",
        "subject": "Science",
        "book": "Curiosity",
        "chapterNumber": "10",
        "chapterName": "Light: Mirrors and Lenses",
        "language": "English",
        "edition": "2026-27",
        **overrides,
    }
    response = client.post(
        "/api/rag/upload",
        data=data,
        files={"file": ("chapter 10.pdf", sample_pdf_bytes(), "application/pdf")},
    )
    if response.status_code == 202 and run_worker:
        assert rag_worker.run_one()
    return response


def sample_pdf_bytes(lines: list[str] | None = None) -> bytes:
    content = lines or [
        "10 Light: Mirrors and Lenses",
        "10.1 Reflection of Light",
        "Definition: Reflection is the bouncing back of light from a surface.",
        "Activity 10.1: Look at your face in a spoon.",
        "Observation: The image may look larger in a curved spoon.",
        "Uses of Concave Mirror: Dentists use concave mirrors to see enlarged images.",
        "Exercise",
        "Why do dentists use mirrors?",
    ]
    document = fitz.open()
    page = document.new_page()
    y = 72
    for line in content:
        page.insert_text((72, y), line, fontsize=11)
        y += 24
    return document.tobytes()


def test_upload_persists_document_and_returns_contract_response(client, token_factory):
    response = upload_pdf(client, token_factory)

    assert response.status_code == 202
    payload = response.json()
    assert payload["documentId"]
    assert payload["status"] == "queued"
    completed=client.get(f"/api/rag/upload/{payload['documentId']}/status").json()
    assert completed["status"] == "ready"
    assert completed["progress"]["entitiesCreated"] > 0
    assert completed["progress"]["chunksCreated"] > 0
    assert completed["progress"]["chunksEmbedded"] == completed["progress"]["chunksCreated"]
    assert payload["metadata"]["schoolId"] == "22222222-2222-2222-2222-222222222222"
    assert payload["metadata"]["board"] == "CBSE"
    assert payload["metadata"]["curriculum"] == "NCERT"
    assert payload["metadata"]["grade"] == 8
    assert payload["metadata"]["chapterNumber"] == 10
    assert payload["metadata"]["sourceType"] == "textbook"

    storage_root = Path(app.state.settings.file_storage_path)
    assert (storage_root / "rag" / "uploads" / f"{payload['documentId']}.pdf").exists()


def test_upload_treats_any_curriculum_as_a_textbook(client, token_factory):
    response = upload_pdf(
        client,
        token_factory,
        board="CIE",
        curriculum="Cambridge",
        book="Checkpoint Science",
    )

    assert response.status_code == 202
    payload = response.json()
    assert payload["metadata"]["board"] == "CIE"
    assert payload["metadata"]["curriculum"] == "CAMBRIDGE"
    assert payload["metadata"]["sourceType"] == "textbook"

    with SessionLocal() as db:
        chunks = db.scalars(
            select(RetrievalChunk).where(RetrievalChunk.document_id == payload["documentId"])
        ).all()
    assert chunks
    assert all(chunk.source.startswith("CAMBRIDGE Science Grade 8") for chunk in chunks)


def test_status_returns_completed_chunking_progress(client, token_factory):
    upload = upload_pdf(client, token_factory).json()

    response = client.get(f"/api/rag/upload/{upload['documentId']}/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["documentId"] == upload["documentId"]
    assert payload["status"] == "ready"
    assert payload["progress"]["stage"] == "ready"
    assert payload["progress"]["percent"] == 100
    assert payload["progress"]["pagesParsed"] == 1
    assert payload["progress"]["entitiesCreated"] > 0
    assert payload["progress"]["chunksCreated"] > 0
    assert payload["progress"]["chunksEmbedded"] == payload["progress"]["chunksCreated"]
    assert payload["errorMessage"] is None
    assert payload["updatedAt"]


def test_document_list_is_school_scoped_and_filterable(client, token_factory):
    science_doc = upload_pdf(client, token_factory).json()
    upload_pdf(client, token_factory, subject="Maths", chapterName="Fractions")

    response = client.get("/api/rag/documents?subject=Science&grade=8&status=ready")

    assert response.status_code == 200
    documents = response.json()["documents"]
    assert len(documents) == 1
    assert documents[0]["documentId"] == science_doc["documentId"]
    assert documents[0]["metadata"] == {
        "board": "CBSE",
        "curriculum": "NCERT",
        "grade": 8,
        "subject": "Science",
        "chapterNumber": 10,
        "chapterName": "Light: Mirrors and Lenses",
    }
    assert documents[0]["entityCount"] > 0
    assert documents[0]["chunkCount"] > 0


def test_status_returns_404_for_another_school_document(client, token_factory):
    upload = upload_pdf(client, token_factory).json()
    client.cookies.set(
        "jwt",
        token_factory(
            role="teacher",
            schoolId="33333333-3333-3333-3333-333333333333",
        ),
    )

    response = client.get(f"/api/rag/upload/{upload['documentId']}/status")

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found."


def test_upload_rejects_non_pdf_file(client, token_factory):
    client.cookies.set("jwt", token_factory(role="teacher"))

    response = client.post(
        "/api/rag/upload",
        data={
            "board": "CBSE",
            "curriculum": "NCERT",
            "grade": "8",
            "subject": "Science",
            "book": "Curiosity",
            "chapterNumber": "10",
            "chapterName": "Light: Mirrors and Lenses",
            "language": "English",
            "edition": "2026-27",
        },
        files={"file": ("chapter.txt", b"not a pdf", "text/plain")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Only PDF uploads are supported."


@pytest.mark.parametrize(
    ("overrides", "detail"),
    [
        ({"grade": "13"}, "grade must be between 1 and 12."),
        ({"chapterNumber": "0"}, "chapterNumber must be positive."),
        ({"subject": "   "}, "subject is required."),
    ],
)
def test_upload_rejects_invalid_metadata(client, token_factory, overrides, detail):
    response = upload_pdf(client, token_factory, **overrides)

    assert response.status_code == 400
    assert response.json()["detail"] == detail


def test_upload_rejects_empty_pdf(client, token_factory):
    client.cookies.set("jwt", token_factory(role="teacher"))

    response = client.post(
        "/api/rag/upload",
        data={
            "board": "CBSE",
            "curriculum": "NCERT",
            "grade": "8",
            "subject": "Science",
            "book": "Curiosity",
            "chapterNumber": "10",
            "chapterName": "Light: Mirrors and Lenses",
            "language": "English",
            "edition": "2026-27",
        },
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Uploaded PDF is empty."


def test_failed_ingestion_persists_failed_status_for_status_endpoint(client, token_factory, monkeypatch):
    def fail_extraction(*_args, **_kwargs):
        raise RuntimeError("parser unavailable")

    monkeypatch.setattr(rag_worker, "run_entity_extraction", fail_extraction)

    response = upload_pdf(client, token_factory)

    with SessionLocal() as db:
        document = db.scalar(select(Document).limit(1))
        job = db.scalar(
            select(DocumentIngestionJob)
            .where(DocumentIngestionJob.document_id == document.id)
            .limit(1)
        )

    status_response = client.get(f"/api/rag/upload/{document.id}/status")
    status_payload = status_response.json()

    assert response.status_code == 202
    assert document.status == DocumentStatus.FAILED.value
    assert document.error_message == "The document could not be processed. Check the PDF and retry."
    assert job.status == IngestionJobStatus.FAILED.value
    assert job.stage == DocumentStatus.FAILED.value
    assert job.error_message == document.error_message
    assert status_response.status_code == 200
    assert status_payload["status"] == DocumentStatus.FAILED.value
    assert status_payload["progress"]["stage"] == DocumentStatus.FAILED.value
    assert status_payload["errorMessage"] == document.error_message


def test_upload_extracts_canonical_concepts_and_classified_entities(client, token_factory):
    payload = upload_pdf(client, token_factory).json()

    with SessionLocal() as db:
        entities = db.scalars(
            select(EducationalEntity).where(EducationalEntity.document_id == payload["documentId"])
        ).all()
        relationships = db.scalars(
            select(EntityRelationship).where(EntityRelationship.document_id == payload["documentId"])
        ).all()

    entity_types = {entity.entity_type for entity in entities}
    canonical_titles = {
        entity.title
        for entity in entities
        if entity.entity_type == EntityType.CANONICAL_CONCEPT.value
    }
    definition = next(
        entity for entity in entities if entity.entity_type == EntityType.DEFINITION.value
    )

    assert EntityType.CANONICAL_CONCEPT.value in entity_types
    assert EntityType.DEFINITION.value in entity_types
    assert EntityType.ACTIVITY.value in entity_types
    assert EntityType.APPLICATION.value in entity_types
    assert EntityType.QUESTION.value in entity_types
    assert "Reflection of Light" in canonical_titles
    assert "Concave Mirror" in canonical_titles
    assert definition.canonical_concept_id
    assert definition.metadata_json["sourceType"] == "textbook"
    assert relationships


def test_upload_generates_semantic_chunks_with_embedding_metadata(client, token_factory):
    payload = upload_pdf(client, token_factory).json()

    with SessionLocal() as db:
        chunks = db.scalars(
            select(RetrievalChunk)
            .where(RetrievalChunk.document_id == payload["documentId"])
            .order_by(RetrievalChunk.chunk_index.asc())
        ).all()

    assert chunks
    assert all(chunk.vector_id for chunk in chunks)
    assert all(chunk.metadata_json["schoolId"] == "22222222-2222-2222-2222-222222222222" for chunk in chunks)
    assert all(chunk.metadata_json["grade"] == 8 for chunk in chunks)
    assert all(chunk.metadata_json["subject"] == "Science" for chunk in chunks)
    assert all(chunk.metadata_json["chapterNumber"] == 10 for chunk in chunks)
    assert all(chunk.metadata_json["collection"].startswith("school_") for chunk in chunks)
    assert all(chunk.source.startswith("NCERT Science Grade 8") for chunk in chunks)
    assert all(chunk.token_count and chunk.token_count > 0 for chunk in chunks)
    assert all(chunk.pedagogical_order is not None for chunk in chunks)
    assert all(chunk.metadata_json["entityId"] == chunk.entity_id for chunk in chunks)
    assert all(chunk.metadata_json["canonicalConceptId"] == chunk.canonical_concept_id for chunk in chunks)
    assert any("Dentists use concave mirrors" in chunk.text for chunk in chunks)
    assert any(chunk.chunk_type == "question" for chunk in chunks)


def test_upload_generates_passage_chunks_from_real_paragraph_text(client, token_factory):
    """Entity chunks are regex-classified sentence fragments; retrieval needs
    real paragraph-length text to ground a tutor answer. This asserts the
    passage chunker actually produces one, not just that entity chunking still
    works (test_upload_generates_semantic_chunks_with_embedding_metadata
    already covers that)."""
    payload = upload_pdf(client, token_factory).json()

    with SessionLocal() as db:
        chunks = db.scalars(
            select(RetrievalChunk)
            .where(RetrievalChunk.document_id == payload["documentId"])
            .order_by(RetrievalChunk.chunk_index.asc())
        ).all()

    passages = [chunk for chunk in chunks if chunk.chunk_type == "passage"]
    assert passages

    passage = passages[0]
    assert passage.entity_id is None
    assert passage.canonical_concept_id is None
    assert passage.vector_id
    assert passage.metadata_json["chunkType"] == "passage"
    assert passage.metadata_json["entityType"] == "Passage"
    assert passage.pedagogical_order >= 600_000
    assert len(passage.text) >= 120
    assert "Dentists use concave mirrors" in passage.text
    # Headings encountered while merging blocks are prefixed onto the passage so
    # a citation is self-contained instead of a bare, context-free line.
    assert "Reflection of Light" in passage.text


def test_passage_chunks_drop_fragments_below_the_minimum_length(client, token_factory):
    """A document with only short, heading-separated lines should not emit a
    passage chunk that's too small to be a useful citation."""
    tiny_pdf = sample_pdf_bytes([
        "1 Tiny Chapter",
        "1.1 Short Section",
        "Ok.",
        "Exercise",
    ])
    client.cookies.set("jwt", token_factory(role="teacher"))
    response = client.post(
        "/api/rag/upload",
        data={
            "board": "CBSE",
            "curriculum": "NCERT",
            "grade": "8",
            "subject": "Science",
            "book": "Curiosity",
            "chapterNumber": "11",
            "chapterName": "Tiny Chapter",
            "language": "English",
            "edition": "2026-27",
        },
        files={"file": ("chapter 11.pdf", tiny_pdf, "application/pdf")},
    )
    assert rag_worker.run_one()
    payload = response.json()

    with SessionLocal() as db:
        chunks = db.scalars(
            select(RetrievalChunk).where(RetrievalChunk.document_id == payload["documentId"])
        ).all()

    assert not [chunk for chunk in chunks if chunk.chunk_type == "passage"]


def test_student_can_download_a_ready_document_file(client, token_factory):
    payload = upload_pdf(client, token_factory).json()

    client.cookies.set("jwt", token_factory(role="student"))
    response = client.get(f"/api/rag/documents/{payload['documentId']}/file")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "inline" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")


def test_ready_document_supports_pdfjs_byte_range_requests(client, token_factory):
    payload = upload_pdf(client, token_factory).json()
    client.cookies.set("jwt", token_factory(role="student"))

    response = client.get(
        f"/api/rag/documents/{payload['documentId']}/file",
        headers={"Range": "bytes=0-99"},
    )

    assert response.status_code == 206
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"].startswith("bytes 0-99/")
    assert len(response.content) == 100
    assert response.content.startswith(b"%PDF")


def test_document_file_404s_for_a_non_ready_document(client, token_factory, monkeypatch):
    def fail_extraction(*_args, **_kwargs):
        raise RuntimeError("parser unavailable")

    monkeypatch.setattr(rag_worker, "run_entity_extraction", fail_extraction)
    upload_pdf(client, token_factory)

    with SessionLocal() as db:
        document = db.scalar(select(Document).limit(1))
        document_id = document.id

    client.cookies.set("jwt", token_factory(role="student"))
    file_response = client.get(f"/api/rag/documents/{document_id}/file")

    assert file_response.status_code == 404


def test_document_file_404s_for_another_schools_document(client, token_factory):
    other_school = "33333333-3333-3333-3333-333333333333"
    payload = upload_pdf(client, token_factory, token_overrides={"schoolId": other_school}).json()

    client.cookies.set("jwt", token_factory(role="student"))
    response = client.get(f"/api/rag/documents/{payload['documentId']}/file")

    assert response.status_code == 404


def test_document_list_excludes_other_schools_and_rejects_bad_status_filter(client, token_factory):
    school_a = "22222222-2222-2222-2222-222222222222"
    school_b = "33333333-3333-3333-3333-333333333333"
    school_a_doc = upload_pdf(client, token_factory).json()
    school_b_doc = upload_pdf(
        client,
        token_factory,
        token_overrides={"schoolId": school_b},
        subject="Science",
        chapterName="Light in Another School",
    ).json()
    client.cookies.set("jwt", token_factory(role="teacher", schoolId=school_a))

    response = client.get("/api/rag/documents?status=ready")
    bad_filter = client.get("/api/rag/documents?status=unknown")

    document_ids = {document["documentId"] for document in response.json()["documents"]}
    assert response.status_code == 200
    assert school_a_doc["documentId"] in document_ids
    assert school_b_doc["documentId"] not in document_ids
    assert bad_filter.status_code == 400
    assert bad_filter.json()["detail"] == "Invalid document status filter."


def test_upload_is_durable_before_worker_runs(client, token_factory):
    response=upload_pdf(client,token_factory,run_worker=False)
    assert response.status_code==202
    with SessionLocal() as db:
        document=db.get(Document,response.json()["documentId"])
        assert document.status=="queued"
        assert db.scalar(select(RetrievalChunk)) is None
    assert rag_worker.run_one()
    assert client.get(f"/api/rag/upload/{response.json()['documentId']}/status").json()["status"]=="ready"
    assert rag_worker.run_one() is False


def test_student_cannot_download_revoked_document(client, token_factory, monkeypatch):
    payload=upload_pdf(client,token_factory).json()
    monkeypatch.setattr(rag_main,"student_document_ids",lambda user: [])
    client.cookies.set("jwt",token_factory(role="student"))
    assert client.get(f"/api/rag/documents/{payload['documentId']}/file").status_code==404
