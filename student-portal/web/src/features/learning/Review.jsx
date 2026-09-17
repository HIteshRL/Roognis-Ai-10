import { useState } from "react";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
export default function Review() {
  const resource = useResource(() => api.get("/quiz/chapters")),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [classId, setClassId] = useState(""),
    [workId, setWorkId] = useState("");
  const quiz = useResource(
    () => (selected ? api.get(`/quiz/${selected}`) : Promise.resolve(null)),
    [selected],
  );
  const classes = useResource(() => api.get("/lms/classrooms"));
  const coursework = useResource(
    () =>
      classId
        ? api.get(`/lms/classrooms/${classId}/coursework`)
        : Promise.resolve({ coursework: [] }),
    [classId],
  );
  async function action(f) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await f();
      resource.reload();
      quiz.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="ASSESSMENT REVIEW"
        title="Your expertise makes it ready."
        description="Inspect generated questions and answers before approving a quiz for your students."
      />
      <ErrorNotice message={error} />
      {notice && (
        <p className="learning-notice" role="status">
          {notice}
        </p>
      )}
      <div className="learning-grid">
        <section className="learning-panel">
          <div className="spread">
            <h2>Chapter quizzes</h2>
            <button className="btn btn-ghost" onClick={resource.reload}>
              Refresh
            </button>
          </div>
          <ResourceState resource={resource}>
            {resource.data?.chapters?.map((source) => (
              <div className="learning-list-row" key={source.sourceId}>
                <div>
                  <strong>{source.chapterName}</strong>
                  <p className="muted">
                    {source.subject} · {source.quizStatus}
                  </p>
                  {source.lastGenerationError && (
                    <p>Generation needs another attempt.</p>
                  )}
                </div>
                {source.activeQuizId ? (
                  <button
                    className="btn btn-outline"
                    onClick={() => setSelected(source.activeQuizId)}
                  >
                    Review
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api.post(
                          `/quiz/sources/${source.sourceId}/generate`,
                        );
                        setNotice(
                          "Quiz generation queued. Refresh to check its progress.",
                        );
                      })
                    }
                  >
                    Generate
                  </button>
                )}
              </div>
            ))}
            {!resource.data?.chapters?.length && (
              <p className="muted">
                Upload and index a chapter in Library to prepare its quiz.
              </p>
            )}
          </ResourceState>
        </section>
        <section className="learning-panel">
          <h2>{quiz.data?.title || "Select a quiz"}</h2>
          {selected && (
            <ResourceState resource={quiz}>
              {quiz.data?.questions?.map((q, i) => (
                <section className="learning-question" key={q.questionId}>
                  <h3>
                    {i + 1}. {q.prompt}
                  </h3>
                  <ul>
                    {q.options.map((o, j) => (
                      <li key={j}>{typeof o === "string" ? o : o.text}</li>
                    ))}
                  </ul>
                  <p>
                    <strong>Answer:</strong> {q.correctAnswer}
                  </p>
                  <p className="muted">{q.explanation}</p>
                </section>
              ))}
              {quiz.data?.status === "pending_review" && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api.post(`/quiz/quizzes/${selected}/approve`);
                      setNotice(
                        "Quiz approved. You can now link it to coursework.",
                      );
                    })
                  }
                >
                  I have reviewed this quiz · Approve
                </button>
              )}
              {quiz.data?.status === "ready" && (
                <form
                  className="learning-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    action(async () => {
                      await api.post(`/lms/coursework/${workId}/link-quiz`, {
                        quizId: selected,
                      });
                      setNotice(
                        "Quiz linked to coursework. Publish the coursework from your class when ready.",
                      );
                    });
                  }}
                >
                  <label>
                    Class
                    <select
                      required
                      value={classId}
                      onChange={(e) => {
                        setClassId(e.target.value);
                        setWorkId("");
                      }}
                    >
                      <option value="">Choose class</option>
                      {classes.data?.classrooms?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Quiz coursework
                    <select
                      required
                      value={workId}
                      onChange={(e) => setWorkId(e.target.value)}
                    >
                      <option value="">Choose coursework</option>
                      {coursework.data?.coursework
                        ?.filter((w) => w.type === "quiz")
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button className="btn btn-primary" disabled={busy}>
                    Link approved quiz
                  </button>
                </form>
              )}
            </ResourceState>
          )}
        </section>
      </div>
    </>
  );
}
