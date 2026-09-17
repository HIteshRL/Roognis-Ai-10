from main import evenly_sample_items
from test_documents import upload_pdf


def test_evenly_samples_context_across_the_whole_chapter():
    items = list(range(100))
    assert evenly_sample_items(items, 5) == [0, 25, 50, 74, 99]


INTERNAL_HEADERS = {"X-Internal-Service-Token": "test-internal-token"}


def test_internal_chapter_discovery_requires_service_token(client, token_factory):
    upload_pdf(client, token_factory)

    response = client.get("/api/rag/internal/chapters")

    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized"


def test_internal_chapter_discovery_returns_ready_chapter_fingerprint(client, token_factory):
    upload = upload_pdf(client, token_factory).json()

    response = client.get("/api/rag/internal/chapters", headers=INTERNAL_HEADERS)

    assert response.status_code == 200
    chapters = response.json()["chapters"]
    assert len(chapters) == 1
    chapter = chapters[0]
    assert chapter["schoolId"] == "22222222-2222-2222-2222-222222222222"
    assert chapter["subject"] == "Science"
    assert chapter["grade"] == 8
    assert chapter["chapterNumber"] == 10
    assert chapter["documentIds"] == [upload["documentId"]]
    assert chapter["entityCount"] > 0
    assert chapter["chunkCount"] > 0
    assert len(chapter["contentFingerprint"]) == 64


def test_internal_chapter_context_returns_ordered_chunks_and_entities(client, token_factory):
    upload = upload_pdf(client, token_factory).json()

    response = client.get(
        f"/api/rag/internal/chapter-context?documentIds={upload['documentId']}",
        headers=INTERNAL_HEADERS,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["chapter"]["documentIds"] == [upload["documentId"]]
    assert payload["chunks"]
    assert payload["entities"]
    expected_concepts = {
        item.get("canonicalConceptId") or item["entityId"]
        for item in payload["entities"]
        if item.get("canonicalConceptId") or item.get("entityType") == "CanonicalConcept"
    }
    assert {item["conceptId"] for item in payload["chapter"]["conceptCatalog"]} == expected_concepts
    first_chunk = payload["chunks"][0]
    assert first_chunk["chunkId"]
    assert first_chunk["text"]
    assert first_chunk["source"].startswith("NCERT Science Grade 8")
    assert first_chunk["metadata"]["subject"] == "Science"
    assert first_chunk["metadata"]["grade"] == 8
