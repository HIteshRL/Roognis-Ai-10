import { Avatar, Badge } from '../../../components/ui'
import { ActionDrawer } from '../../shared/components/ActionDrawer'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { EvidenceViewer } from '../../shared/components/EvidenceViewer'
import { PriorityBadge } from '../../shared/components/PriorityBadge'
import { CAPABILITIES } from '../../shared/services/capability'
import type { SuggestedAction } from '../../shared/types/common'
import { RISK_CATEGORY_BY_ID, type StudentRisk } from '../types/intervention'

const percent = (value: number | null): string => (value === null ? '—' : `${value}%`)

/**
 * Why one student is in the queue.
 *
 * Everything shown here is LMS coursework evidence. The panel says so
 * explicitly, and names the Privacy Guard capability that would add mastery and
 * misconception context — so a teacher knows both what this is based on and
 * what it is not.
 */
export function InterventionDrawer({
  risk,
  onClose,
  onAction,
}: {
  risk: StudentRisk | null
  onClose: () => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element | null {
  if (!risk) return null
  const category = RISK_CATEGORY_BY_ID.get(risk.category)

  return (
    <ActionDrawer
      open
      onClose={onClose}
      title={risk.student.name}
      subtitle={`${category?.label ?? risk.category} · ${risk.student.classroomName ?? ''}`}
      width={560}
      footer={risk.actions.map((action) => (
        <button
          key={action.id}
          className={`btn btn-sm ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => {
            onAction(action)
            onClose()
          }}
        >
          {action.label}
        </button>
      ))}
    >
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={risk.student.name} id={risk.student.studentId} size="lg" />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
            <PriorityBadge priority={risk.priority} />
            <Badge>{category?.icon} {category?.label}</Badge>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {risk.reason}
          </div>
        </div>
      </div>

      <div>
        <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>
          Recommended next step
        </div>
        <div className="small muted">{risk.recommendedAction}</div>
      </div>

      <div>
        <div className="small" style={{ fontWeight: 700, marginBottom: 8 }}>
          What the records show
        </div>
        <dl className="kv">
          <div>
            <dt>Average</dt>
            <dd>
              {percent(risk.metrics.averagePercent)} across {risk.metrics.gradedCount} graded tasks
            </dd>
          </div>
          <div>
            <dt>Recent</dt>
            <dd>
              {percent(risk.metrics.recentAveragePercent)}
              {risk.metrics.earlierAveragePercent !== null &&
                ` (was ${percent(risk.metrics.earlierAveragePercent)})`}
            </dd>
          </div>
          <div>
            <dt>Missing</dt>
            <dd>{risk.metrics.missingCount}</dd>
          </div>
          <div>
            <dt>Late</dt>
            <dd>{risk.metrics.lateCount}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>
              {risk.metrics.daysSinceActivity === null
                ? 'No submissions on record'
                : `${risk.metrics.daysSinceActivity} days ago`}
            </dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>
              <ConfidenceBadge confidence={risk.confidence} />
              <div className="tiny faint" style={{ marginTop: 3 }}>
                {risk.confidence.basis}
              </div>
            </dd>
          </div>
        </dl>
      </div>

      <EvidenceViewer evidence={risk.evidence} provenance={risk.provenance} />

      <CapabilityNotice capability={CAPABILITIES['privacy.class-aggregates']} />
    </ActionDrawer>
  )
}
