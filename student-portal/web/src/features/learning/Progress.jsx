import { Link } from "react-router-dom";
import { Icon, Metric, StatusBadge } from "../../components/ui.jsx";
import { learningApi } from "./client";
import { PageHeading, ResourceState, useResource } from "./shared";

function formatDate(value) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function earliestReview(rows) {
  return rows
    .map((row) => row.retention?.nextReviewAt)
    .filter((value) => value && !Number.isNaN(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
}

export default function Progress() {
  const resource = useResource(learningApi.gaps);
  const rows = resource.data?.knowledgeGaps || [];
  const hasSnapshot = resource.data !== null;
  const evidenceCount = rows.reduce((total, row) => total + Number(row.evidenceCount || 0), 0);
  const nextReview = earliestReview(rows);

  return (
    <>
      <PageHeading
        eyebrow="YOUR LEARNING JOURNEY"
        title="Progress you can understand."
        description="These signals describe the evidence available for each concept. They are not a single identity, rank, or official grade."
      />
      <section className="progress-explainer" aria-label="How progress works">
        <Icon name="insights" size={22} />
        <div><strong>Use this page to choose your next action.</strong><span>Mastery estimates come from available learning evidence. Official grades remain in your classes after they are returned.</span></div>
      </section>
      <div className="progress-metrics" aria-label="Progress evidence summary">
        <Metric label="Concepts with evidence" value={hasSnapshot ? rows.length : "—"} hint="separate from completion" />
        <Metric label="Evidence records" value={hasSnapshot ? evidenceCount : "—"} hint="practice or assessed work" />
        <Metric label="Next suggested review" value={hasSnapshot ? formatDate(nextReview) : "—"} hint="when one is scheduled" tone={hasSnapshot && nextReview ? "success" : "neutral"} />
      </div>
      <ResourceState
        resource={resource}
        empty={!resource.loading && !resource.error && !rows.length ? "Complete some practice or assessed work to start building a picture of your learning." : null}
      >
        <div className="progress-grid">
          <section className="learning-panel progress-list" aria-labelledby="concept-evidence-title">
            <div className="section-heading-row">
              <div><p className="learning-eyebrow">CONCEPT EVIDENCE</p><h2 id="concept-evidence-title">What your recent work suggests</h2></div>
              <StatusBadge tone="info" label="Estimate" icon="insights" />
            </div>
            {rows.map((row) => {
              const mastery = Math.round((row.mastery || 0) * 100);
              return (
                <article className="progress-concept" key={row.conceptId}>
                  <div className="progress-concept-head">
                    <div><h3>{row.conceptLabel || row.conceptId}</h3><span className="tiny muted">{row.evidenceCount || 0} evidence record{row.evidenceCount === 1 ? "" : "s"}</span></div>
                    <StatusBadge tone={mastery >= 70 ? "success" : mastery >= 40 ? "warning" : "info"} label={row.trend || "Building evidence"} />
                  </div>
                  <div className="progress-bar" role="progressbar" aria-label={`${row.conceptLabel || row.conceptId} estimated mastery`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={mastery}><span style={{ width: `${mastery}%` }} /></div>
                  <div className="progress-concept-meta"><span>{mastery}% estimate</span><span>Updated {row.computedAt ? new Date(row.computedAt).toLocaleDateString() : "recently"}</span></div>
                  <p>{row.scaffold || "Keep practising to strengthen your understanding."}</p>
                  <div className="progress-actions"><Link className="btn btn-outline btn-sm" to="/learn">Find a chapter to practise <Icon name="arrow" size={14} /></Link>{row.retention?.nextReviewAt ? <span className="tiny muted">Suggested review {formatDate(row.retention.nextReviewAt)}</span> : null}</div>
                </article>
              );
            })}
          </section>
          <aside className="learning-panel progress-next" aria-labelledby="progress-next-title">
            <p className="learning-eyebrow">NEXT ACTION</p>
            <h2 id="progress-next-title">Turn evidence into practice.</h2>
            <p>Choose a chapter or use spaced review when you want to strengthen recall. A gap is a prompt for support, not a label.</p>
            <div className="progress-next-actions"><Link className="btn btn-primary" to="/learn">Open learning library <Icon name="arrow" size={16} /></Link><Link className="text-link" to="/revision">Review cards <Icon name="arrow" size={15} /></Link></div>
          </aside>
        </div>
      </ResourceState>
    </>
  );
}
