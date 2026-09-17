import { useState } from "react";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
export default function Revision() {
  const resource = useResource(() => api.get("/practice/review/due?limit=20")),
    [index, setIndex] = useState(0),
    [revealed, setRevealed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const card = resource.data?.cards?.[index];
  async function rate(grade) {
    setBusy(true);
    setError("");
    try {
      await api.post("/practice/review/grade", {
        practiceSetId: card.practiceSetId,
        cardId: card.cardId,
        grade,
      });
      setIndex((i) => i + 1);
      setRevealed(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="SPACED REVIEW"
        title="Bring it back to mind."
        description="Try recalling the answer before revealing it. These self-ratings schedule your next review."
      />
      <ResourceState resource={resource}>
        <section className="learning-panel">
          <ErrorNotice message={error} />
          {card ? (
            <>
              <p className="learning-eyebrow">
                CARD {index + 1} OF {resource.data.cards.length}
              </p>
              <h2>{card.front}</h2>
              {revealed ? (
                <>
                  <p>{card.back}</p>
                  <div className="row">
                    {["again", "good", "easy"].map((grade) => (
                      <button
                        className="btn btn-outline"
                        key={grade}
                        disabled={busy}
                        onClick={() => rate(grade)}
                      >
                        {grade}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => setRevealed(true)}
                >
                  Reveal answer
                </button>
              )}
            </>
          ) : (
            <>
              <h2>You’re up to date.</h2>
              <p>New review cards will appear as you practise your chapters.</p>
            </>
          )}
        </section>
      </ResourceState>
    </>
  );
}
