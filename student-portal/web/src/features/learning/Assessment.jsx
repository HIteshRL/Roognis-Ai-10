import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
export default function Assessment() {
  const { quizId } = useParams(),
    resource = useResource(
      () => api.get(`/quiz/student/quizzes/${quizId}`),
      [quizId],
    ),
    [answers, setAnswers] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setAnswers({});
    setBusy(false);
    setError("");
    setSubmitted(false);
  }, [quizId]);
  async function submit(e) {
    e.preventDefault();
    if (busy || submitted) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/quiz/student/quizzes/${quizId}/submit`, { answers });
      setSubmitted(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="ASSESSED WORK"
        title={resource.data?.title || "Your quiz"}
        description="Complete this attempt independently. Your teacher controls when the coursework grade is released."
      />
      <ResourceState resource={resource}>
        <section className="learning-panel">
          <ErrorNotice message={error} />
          {submitted ? (
            <div role="status">
              <h2>Your attempt has been submitted.</h2>
              <p>
                Your answers have been saved. The coursework result will appear
                when your teacher releases it.
              </p>
              <Link to="/classes">Return to classes →</Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              {resource.data?.questions?.map((q, i) => (
                <fieldset className="learning-question" key={q.questionId}>
                  <legend>
                    {i + 1}. {q.prompt}
                  </legend>
                  {q.options?.length ? (
                    q.options.map((o, j) => {
                      const text = typeof o === "string" ? o : o.text;
                      return (
                        <label className="learning-option" key={j}>
                          <input
                            type="radio"
                            required
                            name={q.questionId}
                            checked={answers[q.questionId] === text}
                            onChange={() =>
                              setAnswers({ ...answers, [q.questionId]: text })
                            }
                          />
                          {text}
                        </label>
                      );
                    })
                  ) : (
                    <textarea
                      required
                      value={answers[q.questionId] || ""}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [q.questionId]: e.target.value,
                        })
                      }
                    />
                  )}
                </fieldset>
              ))}
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Submitting…" : "Submit attempt"}
              </button>
            </form>
          )}
        </section>
      </ResourceState>
    </>
  );
}
