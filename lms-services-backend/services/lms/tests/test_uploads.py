import io
from pathlib import Path

import pytest

from conftest import SCHOOL_B


def cookie(token):
    return {"jwt": token}


def test_requires_auth(client):
    res = client.post("/api/lms/uploads", files={"file": ("worksheet.pdf", b"%PDF-1.4 fake", "application/pdf")})
    assert res.status_code == 401


def test_student_cannot_upload(client, token_factory):
    student = token_factory("student")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("worksheet.pdf", b"%PDF-1.4 fake", "application/pdf")},
        cookies=cookie(student),
    )
    assert res.status_code == 403


def test_teacher_uploads_pdf_and_downloads_it(client, token_factory):
    teacher = token_factory("teacher")
    content = b"%PDF-1.4 fake worksheet bytes"
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("Photosynthesis Worksheet.pdf", content, "application/pdf")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["type"] == "file"
    assert body["title"] == "Photosynthesis_Worksheet.pdf"
    assert body["url"].startswith("/api/lms/uploads/")

    download = client.get(body["url"], cookies=cookie(teacher))
    assert download.status_code == 200
    assert download.content == content
    assert download.headers["content-type"] == "application/pdf"


def test_rejects_unsupported_extension(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("virus.exe", b"MZ fake binary", "application/octet-stream")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_rejects_mismatched_content_type(client, token_factory):
    """A .pdf extension paired with an unrelated declared Content-Type
    (not the generic octet-stream fallback either) must still be rejected —
    the extension and content-type allow-lists are correlated per
    extension, not independently satisfiable (the OR-shaped bug this
    module's docstring names)."""
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("worksheet.pdf", b"<html>not a pdf</html>", "text/html")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_accepts_generic_content_type_fallback(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("slides.pptx", b"fake pptx bytes", "application/octet-stream")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 201, res.text


def test_rejects_oversized_upload(client, token_factory, monkeypatch):
    import config

    monkeypatch.setattr(config.get_settings(), "lms_max_upload_mb", 1, raising=False)
    teacher = token_factory("teacher")
    oversized = io.BytesIO(b"0" * (2 * 1024 * 1024))
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("big.pdf", oversized, "application/pdf")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 413


def test_rejects_empty_upload(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("empty.pdf", b"", "application/pdf")},
        cookies=cookie(teacher),
    )
    assert res.status_code == 400


def test_download_is_school_scoped(client, token_factory):
    teacher = token_factory("teacher")
    res = client.post(
        "/api/lms/uploads",
        files={"file": ("notes.txt", b"class notes", "text/plain")},
        cookies=cookie(teacher),
    )
    url = res.json()["url"]

    intruder = token_factory("teacher", school_id=SCHOOL_B)
    cross = client.get(url, cookies=cookie(intruder))
    assert cross.status_code == 404

    same_school_student = token_factory("student")
    ok = client.get(url, cookies=cookie(same_school_student))
    assert ok.status_code == 200


def test_failed_commit_does_not_orphan_the_uploaded_file(client, token_factory, monkeypatch):
    """Regression for the reordering in uploads.py (plan Phase 2.3). The
    previous flow was: INSERT+flush the row, stream up to 20 MB to disk,
    commit. A failure at the commit step left a fully-written file on the
    shared file_storage volume with no row referencing it and no reaper.

    Now the write happens to a temp path *before* the database is touched at
    all, so a failed commit has nothing to clean up on the DB side and the
    file write's own failure path (already covered by
    test_rejects_oversized_upload / test_rejects_empty_upload) never reaches
    the database. This test forces the commit itself to fail — the one step
    that still runs after the file exists on disk — and asserts neither the
    temp file nor the final file survives it."""
    import uploads as uploads_module
    from config import get_settings
    from sqlalchemy.orm import Session as OrmSession

    teacher = token_factory("teacher")
    fixed_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    monkeypatch.setattr(uploads_module, "new_uuid", lambda: fixed_id)

    def failing_commit(self):
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(OrmSession, "commit", failing_commit)

    with pytest.raises(RuntimeError, match="simulated DB failure"):
        client.post(
            "/api/lms/uploads",
            files={"file": ("worksheet.pdf", b"%PDF-1.4 fake bytes", "application/pdf")},
            cookies=cookie(teacher),
        )

    monkeypatch.undo()  # restore Session.commit before touching the DB again

    settings = get_settings()
    upload_dir = Path(settings.file_storage_path) / "lms" / "uploads"
    final_path = upload_dir / f"{fixed_id}.pdf"
    temp_path = upload_dir / f".{fixed_id}.pdf.part"

    assert not final_path.exists(), "a failed commit must never leave the final file behind"
    assert not temp_path.exists(), "a failed commit must clean up its temp file"

    # And the row itself must not exist either — the commit that would have
    # created it raised.
    lookup = client.get(f"/api/lms/uploads/{fixed_id}", cookies=cookie(teacher))
    assert lookup.status_code == 404


def test_unknown_upload_id_is_404(client, token_factory):
    teacher = token_factory("teacher")
    res = client.get("/api/lms/uploads/does-not-exist", cookies=cookie(teacher))
    assert res.status_code == 404


def test_upload_can_be_attached_to_coursework(client, token_factory):
    teacher = token_factory("teacher")
    classroom = client.post(
        "/api/lms/classrooms", json={"name": "Class 8 Science", "subject": "Science"}, cookies=cookie(teacher)
    ).json()

    uploaded = client.post(
        "/api/lms/uploads",
        files={"file": ("handout.pdf", b"%PDF-1.4 handout", "application/pdf")},
        cookies=cookie(teacher),
    ).json()

    coursework = client.post(
        f"/api/lms/classrooms/{classroom['id']}/coursework",
        json={"title": "HW1", "attachments": [uploaded]},
        cookies=cookie(teacher),
    )
    assert coursework.status_code == 201, coursework.text
    assert coursework.json()["attachments"] == [uploaded]
