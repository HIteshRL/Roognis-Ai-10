import { useState } from "react";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
const fields = [
  ["board", "Board"],
  ["curriculum", "Curriculum"],
  ["grade", "Grade"],
  ["subject", "Subject"],
  ["book", "Book"],
  ["chapterNumber", "Chapter number"],
  ["chapterName", "Chapter title"],
  ["language", "Language"],
  ["edition", "Edition"],
];
export default function Library() {
  const documents = useResource(() => api.get("/rag/documents")),
    classes = useResource(() => api.get("/lms/classrooms")),
    [classroom, setClassroom] = useState(""),
    [chapter, setChapter] = useState(""),
    [documentId, setDocument] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const chapters = useResource(
    () =>
      classroom
        ? api.get(`/lms/classrooms/${classroom}/chapters`)
        : Promise.resolve({ chapters: [] }),
    [classroom],
  );
  async function upload(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.upload("/rag/upload", form);
      setNotice(
        "Upload received. Processing status appears in your document library.",
      );
      documents.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function publish(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const version = await api.post(`/lms/chapters/${chapter}/versions`, {
        documentId,
      });
      await api.post(`/lms/chapter-versions/${version.id}/publish`);
      setNotice(
        "Chapter published. Enrolled students can now open it in Learn.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="CURRICULUM LIBRARY"
        title="Turn your curriculum into a learning space."
        description="Upload source material, check its processing status, then publish it to a class chapter."
      />
      <ErrorNotice message={error} />
      {notice && (
        <p className="learning-notice" role="status">
          {notice}
        </p>
      )}
      <div className="learning-grid">
        <section className="learning-panel">
          <h2>1. Upload a chapter</h2>
          <form className="learning-form" onSubmit={upload}>
            <label>
              Source PDF
              <input
                type="file"
                name="file"
                accept="application/pdf"
                required
              />
            </label>
            <div className="learning-form-grid">
              {fields.map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input
                    name={name}
                    type={
                      ["grade", "chapterNumber"].includes(name)
                        ? "number"
                        : "text"
                    }
                    min="1"
                    max={name === "grade" ? 12 : undefined}
                    required
                    defaultValue={name === "language" ? "English" : undefined}
                  />
                </label>
              ))}
            </div>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Working…" : "Upload source"}
            </button>
          </form>
        </section>
        <section className="learning-panel">
          <h2>2. Publish to your class</h2>
          <ResourceState resource={classes}>
            <form className="learning-form" onSubmit={publish}>
              <label>
                Class
                <select
                  required
                  value={classroom}
                  onChange={(e) => {
                    setClassroom(e.target.value);
                    setChapter("");
                  }}
                >
                  <option value="">Choose a class</option>
                  {classes.data?.classrooms?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Chapter
                <select
                  required
                  value={chapter}
                  onChange={(e) => setChapter(e.target.value)}
                >
                  <option value="">Choose a chapter</option>
                  {chapters.data?.chapters?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Indexed document
                <select
                  required
                  value={documentId}
                  onChange={(e) => setDocument(e.target.value)}
                >
                  <option value="">Choose a source</option>
                  {documents.data?.documents
                    ?.filter((d) =>
                      ["ready", "indexed", "done"].includes(d.status),
                    )
                    .map((d) => (
                      <option value={d.documentId} key={d.documentId}>
                        {d.metadata?.chapterName || d.filename}
                      </option>
                    ))}
                </select>
              </label>
              <p className="muted">
                Publishing creates a version and makes this source available to
                enrolled students. Existing versions are retained.
              </p>
              <button
                className="btn btn-primary"
                disabled={busy || !chapter || !documentId}
              >
                Publish chapter
              </button>
            </form>
          </ResourceState>
        </section>
      </div>
      <section className="learning-panel">
        <div className="spread">
          <h2>Your documents</h2>
          <button className="btn btn-outline" onClick={documents.reload}>
            Refresh status
          </button>
        </div>
        <ResourceState resource={documents}>
          {documents.data?.documents?.map((d) => (
            <div className="learning-list-row" key={d.documentId}>
              <div>
                <strong>{d.metadata?.chapterName || d.filename}</strong>
                <p className="muted">
                  {d.metadata?.subject} · {d.metadata?.book}
                </p>
              </div>
              <span className="learning-pill">{d.status}</span>
            </div>
          ))}
          {!documents.data?.documents?.length && (
            <p className="muted">Upload your first source to get started.</p>
          )}
        </ResourceState>
      </section>
    </>
  );
}
