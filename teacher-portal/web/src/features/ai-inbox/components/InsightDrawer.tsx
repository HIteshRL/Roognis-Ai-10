import { Avatar, Badge } from '../../../components/ui'
import { fmtDateTime } from '../../../lib/format'
import { ActionDrawer } from '../../shared/components/ActionDrawer'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { EvidenceViewer } from '../../shared/components/EvidenceViewer'
import { PriorityBadge } from '../../shared/components/PriorityBadge'
import type { SuggestedAction } from '../../shared/types/common'
import type { AIInsight, InsightStatus } from '../types/insight'

/**
 * AI recommendation details.
 *
 * This is the §7 explainability contract as a screen: the observation, the
 * method that produced it, the confidence and the sample it rests on, every
 * affected student, and the evidence records — each one a link to the actual
 * task. A teacher should be able to disagree with this panel on the facts.
 */
export function InsightDrawer({
  insight,
  status,
  onClose,
  onAccept,
  onDismiss,
  onAction,
}: {
  insight: AIInsight | null
  status: InsightStatus
  onClose: () => void
  onAccept: (insight: AIInsight) => void
  onDismiss: (insight: AIInsight) => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element | null {
  if (!insight) return null

  return (
    <ActionDrawer
      open
      onClose={onClose}
      title={insight.title}
      subtitle={`${insight.classroomName} · detected ${fmtDateTime(insight.detectedAt)}`}
      width={620}
      footer={
        <>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              onDismiss(insight)
              onClose()
            }}
          >
            Dismiss
          </button>
          {insight.actions.map((action) => (
            <button
              key={action.id}
              className={`btn btn-sm ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => {
                onAction(action)
                onAccept(insight)
                onClose()
              }}
            >
              {action.label}
            </button>
          ))}
        </>
      }
    >
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <PriorityBadge priority={insight.priority} />
        <Badge>{insight.classroomName}</Badge>
        {status === 'accepted' && <Badge tone="success">Accepted</Badge>}
        {status === 'dismissed' && <Badge>Dismissed</Badge>}
      </div>

      <div>
        <div className="small" style={{ fontWeight: 700, marginBottom: 5 }}>
          What was observed
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {insight.explanation}
        </p>
      </div>

      <div>
        <div className="small" style={{ fontWeight: 700, marginBottom: 5 }}>
          How it was worked out
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {insight.method}
        </p>
      </div>

      <div>
        <div className="small" style={{ fontWeight: 700, marginBottom: 7 }}>
          Confidence
        </div>
        <ConfidenceBadge confidence={insight.confidence} />
        <div className="tiny faint" style={{ marginTop: 4 }}>
          {insight.confidence.basis}. No finite sample produces certainty, so this never reaches 100%.
        </div>
      </div>

      {insight.affectedStudents.length > 0 && (
        <div>
          <div className="small" style={{ fontWeight: 700, marginBottom: 7 }}>
            Affected students ({insight.affectedStudents.length})
          </div>
          <div className="row wrap" style={{ gap: 7 }}>
            {insight.affectedStudents.map((student) => (
              <span key={student.studentId} className="badge" style={{ gap: 6, paddingLeft: 3 }}>
                <Avatar name={student.name} id={student.studentId} size="sm" />
                {student.name}
              </span>
            ))}
          </div>
          <div className="tiny faint" style={{ marginTop: 6 }}>
            Named from your own gradebook and submission records — not from learner-model state.
          </div>
        </div>
      )}

      <EvidenceViewer evidence={insight.evidence} provenance={insight.provenance} />
    </ActionDrawer>
  )
}
