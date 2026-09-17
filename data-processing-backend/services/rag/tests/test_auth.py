def upload_form():
    return {
        "board": "CBSE",
        "curriculum": "NCERT",
        "grade": "8",
        "subject": "Science",
        "book": "Curiosity",
        "chapterNumber": "10",
        "chapterName": "Light: Mirrors and Lenses",
        "language": "English",
        "edition": "2026-27",
    }


def upload_file():
    return {"file": ("chapter.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")}


def test_ingestion_endpoint_requires_jwt_cookie(client):
    response = client.get("/api/rag/documents")

    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized"


def test_document_list_allows_student_role(client, token_factory):
    token = token_factory(role="student")
    client.cookies.set("jwt", token)

    response = client.get("/api/rag/documents")

    assert response.status_code == 200
    assert response.json() == {"documents": []}


def test_teacher_jwt_reaches_protected_documents_handler(client, token_factory):
    token = token_factory(role="teacher")
    client.cookies.set("jwt", token)

    response = client.get("/api/rag/documents")

    assert response.status_code == 200
    assert response.json() == {"documents": []}


def test_upload_requires_jwt_cookie(client):
    response = client.post(
        "/api/rag/upload",
        data=upload_form(),
        files=upload_file(),
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized"


def test_upload_rejects_non_teacher_role(client, token_factory):
    client.cookies.set("jwt", token_factory(role="student"))

    response = client.post(
        "/api/rag/upload",
        data=upload_form(),
        files=upload_file(),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"


def test_status_endpoint_requires_teacher_jwt(client, token_factory):
    document_id = "22222222-2222-2222-2222-222222222222"
    response_without_cookie = client.get(f"/api/rag/upload/{document_id}/status")

    client.cookies.set("jwt", token_factory(role="student"))
    response_with_student = client.get(f"/api/rag/upload/{document_id}/status")

    assert response_without_cookie.status_code == 401
    assert response_without_cookie.json()["detail"] == "Unauthorized"
    assert response_with_student.status_code == 403
    assert response_with_student.json()["detail"] == "Forbidden"
