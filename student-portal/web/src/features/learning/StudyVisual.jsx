import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";

const SUBJECT_MODES = [
  { match: /math|algebra|geometry|calculus|statistics|numeracy/i, mode: "math" },
  { match: /physics|chemistry|biology|science|environmental/i, mode: "science" },
  { match: /english|literature|language|grammar|writing|reading|hindi|sanskrit|french|spanish/i, mode: "language" },
  { match: /history|geography|civics|political|economics|social/i, mode: "history" },
  { match: /computer|coding|programming|technology|informatics/i, mode: "technology" },
];

function subjectMode(subject) {
  return SUBJECT_MODES.find(({ match }) => match.test(subject || ""))?.mode || "general";
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function fallbackShape(mode) {
  if (mode === "math") return <><i className="study-visual-line study-visual-line-a" /><i className="study-visual-line study-visual-line-b" /><i className="study-visual-orbit" /><b className="study-visual-block study-visual-block-a" /><b className="study-visual-block study-visual-block-b" /></>;
  if (mode === "science") return <><i className="study-visual-ring study-visual-ring-a" /><i className="study-visual-ring study-visual-ring-b" /><b className="study-visual-node study-visual-node-a" /><b className="study-visual-node study-visual-node-b" /><i className="study-visual-field" /></>;
  if (mode === "language") return <><i className="study-visual-glyph study-visual-glyph-a" /><i className="study-visual-glyph study-visual-glyph-b" /><i className="study-visual-glyph study-visual-glyph-c" /><b className="study-visual-card study-visual-card-a" /><b className="study-visual-card study-visual-card-b" /></>;
  if (mode === "history") return <><i className="study-visual-strata study-visual-strata-a" /><i className="study-visual-strata study-visual-strata-b" /><i className="study-visual-route" /><b className="study-visual-node study-visual-node-a" /><b className="study-visual-node study-visual-node-c" /></>;
  if (mode === "technology") return <><i className="study-visual-circuit study-visual-circuit-a" /><i className="study-visual-circuit study-visual-circuit-b" /><b className="study-visual-node study-visual-node-a" /><b className="study-visual-node study-visual-node-b" /><b className="study-visual-node study-visual-node-c" /></>;
  return <><i className="study-visual-line study-visual-line-a" /><i className="study-visual-ring study-visual-ring-a" /><b className="study-visual-block study-visual-block-a" /><b className="study-visual-node study-visual-node-b" /></>;
}

function isPending(status) {
  return status === "queued" || status === "processing";
}

/**
 * A visual shell that is useful before, during, and after DGX generation.
 * The fallback is intentionally CSS geometry rather than a random stock image:
 * it keeps the subject signal and composition stable even when the model is down.
 */
export default function StudyVisual({ chapter, compact = false, initialVisual = null }) {
  const [visual, setVisual] = useState(initialVisual);
  const [status, setStatus] = useState(initialVisual?.status || "idle");
  const mode = useMemo(() => subjectMode(chapter?.context?.subject), [chapter?.context?.subject]);

  useEffect(() => {
    let active = true;
    let timer;
    let attempts = 0;
    if (!chapter?.documentId) return undefined;
    const theme = currentTheme();
    setStatus(initialVisual?.status || "loading");
    api.post("/ai/study-visuals/activate", { documentId: chapter.documentId, theme })
      .then((result) => {
        if (!active) return;
        setVisual(result);
        setStatus(result.status || "unavailable");
        if (isPending(result.status)) {
          timer = setInterval(async () => {
            attempts += 1;
            if (attempts > 60 || !result.visualId) {
              clearInterval(timer);
              return;
            }
            try {
              const next = await api.get(`/ai/study-visuals/${encodeURIComponent(result.visualId)}`);
              if (!active) return;
              setVisual(next);
              setStatus(next.status || "unavailable");
              if (!isPending(next.status)) clearInterval(timer);
            } catch {
              // Keep the deterministic fallback on transient poll failures.
            }
          }, 3000);
        }
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [chapter?.documentId, chapter?.id]);

  const generated = visual?.status === "done" && visual.imageUrl;
  const statusLabel = generated
    ? "Chapter visual"
    : isPending(status)
      ? "Composing a chapter visual"
      : status === "failed"
        ? "Abstract subject fallback"
        : "Subject visual system";
  const title = chapter?.context?.subject || visual?.subject || "Learning";

  return (
    <figure className={`study-visual study-visual-${mode}${compact ? " study-visual-compact" : ""}`} data-state={status} aria-label={`${title} subject visual`}>
      <div className="study-visual-art">
        <div className="study-visual-grid" aria-hidden="true" />
        <div className="study-visual-fallback" aria-hidden="true">{fallbackShape(mode)}</div>
        {generated ? <img className="study-visual-image" src={visual.imageUrl} alt="" aria-hidden="true" /> : null}
        <span className="study-visual-signal" aria-hidden="true" />
      </div>
      {!compact ? (
        <figcaption className="study-visual-caption">
          <span className="learning-eyebrow">{statusLabel}</span>
          <strong>{title}</strong>
          <small>{visual?.chapterName || chapter?.context?.chapterName || "A visual cue that follows your current chapter."}</small>
        </figcaption>
      ) : <figcaption className="sr-only">{statusLabel} for {title}</figcaption>}
    </figure>
  );
}
