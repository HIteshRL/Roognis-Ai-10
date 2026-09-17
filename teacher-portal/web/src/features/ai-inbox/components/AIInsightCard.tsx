import { Avatar, Badge } from '../../../components/ui'
import { relTime } from '../../../lib/format'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { PriorityBadge } from '../../shared/components/PriorityBadge'
import type { SuggestedAction } from '../../shared/types/common'
import type { AIInsight, InsightStatus } from '../types/insight'

/** Students named on an insight before the list collapses to a count. */
const STUDENT_CHIP_LIMIT = 6

/**
 * One insight in the inbox.
 *
 * Ordered the way a teacher reads it: what happened, how sure the system is,
 * who it affects, what to do. Accept and dismiss are both first-class — an
 * insight a teacher can only accept is a demand, not a suggestion.
 */
export function AIInsightCard({
  insight,
  status,
  onAccept,
  onDismiss,
  onRestore,
  onViewDetails,
  onAction,
}: {
  insight: AIInsight
  status: InsightStatus
  onAccept: (insight: AIInsight) => void
  onDismiss: (insight: AIInsight) => void
  onRestore: (insight: AIInsight) => void
  onViewDetails: (insight: AIInsight) => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const resolved = status !== 'open'
  const extraStudents = insight.affectedStudents.length - STUDENT_CHIP_LIMIT

  return (
    <article className="insight" style={resolved ? { opacity: 0.62 } : undefined}>
      <div className="insight-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 5 }}>
            <PriorityBadge priority={insight.priority} />
            <Badge>{insight.classroomName}</Badge>
            {status === 'accepted' && <Badge tone="success">Accepted</Badge>}
            {status === 'dismissed' && <Badge>Dismissed</Badge>}
          </div>

          <h3 className="insight-title">{insight.title}</h3>
          <p className="insight-expl">{insight.explanation}</p>
        </div>

        <div className="col" style={{ alignItems: 'flex-end', gap: 5, flex: 'none' }}>
          <ConfidenceBadge confidence={insight.confidence} />
          <span className="tiny faint">{relTime(insight.detectedAt)}</span>
        </div>
      </div>

      {insight.affectedStudents.length > 0 && (
        <div className="insight-students">
          <span className="tiny faint" style={{ alignSelf: 'center', marginRight: 2 }}>
            Affects:
          </span>
          {insight.affectedStudents.slice(0, STUDENT_CHIP_LIMIT).map((student) => (
            <span
              key={student.studentId}
              className="badge"
              title={student.name}
              style={{ gap: 6, paddingLeft: 3 }}
            >
              <Avatar name={student.name} id={student.studentId} size="sm" />
              {student.name}
            </span>
          ))}
          {extraStudents > 0 && <span className="badge">+{extraStudents} more</span>}
        </div>
      )}

      <div className="insight-actions">
        {!resolved &&
          insight.actions.map((action) => (
            <button
              key={action.id}
              className={`btn btn-sm ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => {
                onAction(action)
                onAccept(insight)
              }}
            >
              {action.label}
            </button>
          ))}

        <button className="btn btn-ghost btn-sm" onClick={() => onViewDetails(insight)}>
          View details
        </button>

        {resolved ? (
          <button className="btn btn-ghost btn-sm" onClick={() => onRestore(insight)}>
            Reopen
          </button>
        ) : (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => onAccept(insight)}>
              Accept
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onDismiss(insight)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </article>
  )
}
