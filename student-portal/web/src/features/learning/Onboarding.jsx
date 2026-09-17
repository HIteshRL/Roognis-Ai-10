import { useState } from "react";
import { api } from "../../api/client";
import { ErrorNotice } from "./shared";
export default function Onboarding({ initial, onComplete }) {
  const [data, setData] = useState(initial),
    [answers, setAnswers] = useState(initial.answers || {}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function act(f) {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="learning-panel">
      <p className="learning-eyebrow">YOUR TUTOR, YOUR PREFERENCES</p>
      <h2>Let’s get to know how you like to learn.</h2>
      <p>
        These answers personalise explanations. They do not affect your grades.
      </p>
      <ErrorNotice message={error} />
      {!data.questions ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            act(async () => setData(await api.post("/ai/onboarding/start")))
          }
        >
          Set up my tutor
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await api.post("/ai/onboarding/complete", { answers });
              onComplete();
            });
          }}
        >
          {data.questions.map((q) => (
            <fieldset className="learning-question" key={q.id}>
              <legend>{q.prompt}</legend>
              {q.helper && <p className="muted">{q.helper}</p>}
              {q.type === "text" ? (
                <textarea
                  required
                  maxLength={500}
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              ) : (
                q.options.map((option) => (
                  <label className="learning-option" key={option}>
                    <input
                      type={q.type === "multiselect" ? "checkbox" : "radio"}
                      name={q.id}
                      checked={
                        q.type === "multiselect"
                          ? (answers[q.id] || []).includes(option)
                          : answers[q.id] === option
                      }
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [q.id]:
                            q.type === "multiselect"
                              ? e.target.checked
                                ? [...(answers[q.id] || []), option]
                                : (answers[q.id] || []).filter(
                                    (x) => x !== option,
                                  )
                              : option,
                        })
                      }
                    />
                    {option}
                  </label>
                ))
              )}
            </fieldset>
          ))}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Preparing your tutor…" : "Save preferences"}
          </button>
        </form>
      )}
    </section>
  );
}
