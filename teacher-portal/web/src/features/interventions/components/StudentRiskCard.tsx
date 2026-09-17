import { Avatar } from '../../../components/ui'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import type { SuggestedAction } from '../../shared/types/common'
import type { StudentRisk } from '../types/intervention'

/**
 * One row of the intervention queue.
 *
 * The row leads with the reason, not the label: "averaging 31% across 4 graded
 * tasks" tells a teacher what to do next, while "at risk" does not. Confidence
 * and the recommended action sit beside it so the row is actionable without
 * opening anything.
 */
export function StudentRiskCard({
  risk,
  onAction,
  onOpenDetail,
  compact = false,
}: {
  risk: StudentRisk
  onAction: (action: SuggestedAction) => void
  onOpenDetail: (risk: StudentRisk) => void
  compact?: boolean
}): JSX.Element {
  return (
    <article className="risk-row">
      <Avatar name={risk.student.name} id={risk.student.studentId} size={compact ? 'sm' : 'md'} />

      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="cc-row-title"
            onClick={() => onOpenDetail(risk)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--text)',
              font: 'inherit',
              fontWeight: 650,
            }}
          >
            {risk.student.name}
          </button>
          <ConfidenceBadge confidence={risk.confidence} compact />
        </div>

        <div className="risk-reason">{risk.reason}</div>

        {!compact && (
          <div className="tiny faint" style={{ marginTop: 4 }}>
            → {risk.recommendedAction}
          </div>
        )}
      </div>

      <div className="risk-actions">
        {risk.actions.slice(0, compact ? 1 : 2).map((action) => (
          <button
            key={action.id}
            className={`btn btn-sm ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onOpenDetail(risk)}
          aria-label={`Why ${risk.student.name} is flagged`}
        >
          Why?
        </button>
      </div>
    </article>
  )
}
