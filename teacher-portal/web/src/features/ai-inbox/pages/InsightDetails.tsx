import { Link, useNavigate, useParams } from 'react-router-dom'
import { Avatar, Badge, EmptyState, Loading } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { EvidenceViewer } from '../../shared/components/EvidenceViewer'
import { PriorityBadge } from '../../shared/components/PriorityBadge'
import { useActionDispatch } from '../../workflows/hooks/useActionDispatch'
import { useAIInbox } from '../hooks/useAIInbox'

/**
 * AI Recommendation Details — the deep-linkable form of the drawer.
 *
 * A recommendation a teacher acted on should be shareable with a colleague or a
 * head of department, which means it needs a URL. The insight id is
 * deterministic (`weak-task:{courseworkId}`), so the same link resolves to the
 * same claim on any rescan for as long as the evidence stands.
 */
export default function InsightDetails(): JSX.Element {
  const { insightId } = useParams<{ insightId: string }>()
  const inbox = useAIInbox()
  const dispatch = useActionDispatch()
  const navigate = useNavigate()

  if (inbox.factsQuery.status === 'loading') return <Loading label="Loading the recommendation…" />

  const insight = inbox.insights.find((entry) => entry.id === insightId) ?? null

  if (!insight) {
    return (
      <EmptyState
        icon="insights"
        title="That recommendation is no longer active"
        hint="Insights are recomputed from your records on every scan. If the evidence changed, the recommendation no longer applies."
        action={
          <Link className="btn btn-primary btn-sm" to="/inbox">
            Back to the AI Inbox
          </Link>
        }
      />
    )
  }

  const status = inbox.statusOf(insight.id)

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <Link to="/inbox" className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }}>
        ← AI Inbox
      </Link>

      <header className="page-head">
        <div>
          <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 7 }}>
            <PriorityBadge priority={insight.priority} />
            <Badge>{insight.classroomName}</Badge>
            {status === 'accepted' && <Badge tone="success">Accepted</Badge>}
            {status === 'dismissed' && <Badge>Dismissed</Badge>}
          </div>
          <h1>{insight.title}</h1>
          <div className="page-sub">Detected {fmtDateTime(insight.detectedAt)}</div>
        </div>
        <ConfidenceBadge confidence={insight.confidence} />
      </header>

      <div className="col" style={{ gap: 16 }}>
        <section className="card card-pad">
          <h2 style={{ fontSize: 15, marginBottom: 7 }}>What was observed</h2>
          <p className="small muted" style={{ margin: 0 }}>
            {insight.explanation}
          </p>
        </section>

        <section className="card card-pad">
          <h2 style={{ fontSize: 15, marginBottom: 7 }}>How it was worked out</h2>
          <p className="small muted" style={{ margin: '0 0 12px' }}>
            {insight.method}
          </p>
          <dl className="kv">
            <div>
              <dt>Confidence</dt>
              <dd>
                {Math.round(insight.confidence.score * 100)}% · {insight.confidence.basis}
              </dd>
            </div>
            <div>
              <dt>Ruleset</dt>
              <dd>
                <code>{insight.provenance.rulesetVersion}</code>
              </dd>
            </div>
            <div>
              <dt>Gate</dt>
              <dd>
                <code>{insight.provenance.gateVersion}</code>
              </dd>
            </div>
            <div>
              <dt>Computed by</dt>
              <dd>
                <code>{insight.provenance.computedBy}</code> — deterministic rules, no model
              </dd>
            </div>
          </dl>
        </section>

        {insight.affectedStudents.length > 0 && (
          <section className="card card-pad">
            <h2 style={{ fontSize: 15, marginBottom: 10 }}>
              Affected students ({insight.affectedStudents.length})
            </h2>
            <div className="row wrap" style={{ gap: 7 }}>
              {insight.affectedStudents.map((student) => (
                <span key={student.studentId} className="badge" style={{ gap: 6, paddingLeft: 3 }}>
                  <Avatar name={student.name} id={student.studentId} size="sm" />
                  {student.name}
                </span>
              ))}
            </div>
          </section>
        )}

        <section className="card card-pad">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Evidence</h2>
          <EvidenceViewer evidence={insight.evidence} provenance={insight.provenance} />
        </section>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {insight.actions.map((action) => (
            <button
              key={action.id}
              className={`btn ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => {
                dispatch(action)
                inbox.accept(insight)
              }}
            >
              {action.label}
            </button>
          ))}
          {status === 'open' ? (
            <button
              className="btn btn-ghost"
              onClick={() => {
                inbox.dismiss(insight)
                navigate('/inbox')
              }}
            >
              Dismiss
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => inbox.restore(insight)}>
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
