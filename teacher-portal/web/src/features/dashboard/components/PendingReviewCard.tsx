import { Badge, Icon } from '../../../components/ui'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { DashboardCard } from '../../shared/components/DashboardCard'
import { CAPABILITIES, type CapabilityId } from '../../shared/services/capability'
import type { AsyncStatus, SuggestedAction } from '../../shared/types/common'
import { PRIORITY_TONE } from '../services/dashboardService'
import type { PendingReview, PendingReviewSummary } from '../types/dashboard'

const ICON: Readonly<Record<PendingReview['kind'], string>> = {
  'assignment-grading': 'library',
  'quiz-review': 'check',
  'late-submission': 'calendar',
  'student-doubt': 'inbox',
  'guardian-message': 'family',
  'held-grades': 'settings',
  'pending-enrollment': 'classroom',
  'missing-work': 'warning',
  'scheduled-soon': 'calendar',
  'draft-unpublished': 'book',
}

export function PendingReviewCard({
  summary,
    status,
    error,
    refreshing,
    hasData,
  onRetry,
  onAction,
}: {
  summary: PendingReviewSummary | null
  status: AsyncStatus
  error: Error | null
  refreshing: boolean
  hasData?: boolean
  onRetry: () => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const rows = summary?.items ?? []
  const live = rows.filter((row) => row.capability === null)
  const blocked = rows.filter(
    (row): row is PendingReview & { capability: CapabilityId } => row.capability !== null,
  )

  return (
    <DashboardCard
      title="Pending reviews"
      icon="inbox"
      subtitle="Everything waiting on you"
      status={status}
      error={error}
      refreshing={refreshing}
      hasData={hasData}
      onRetry={onRetry}
      isEmpty={live.length === 0 && blocked.length === 0}
      emptyIcon="check"
      emptyTitle="Nothing waiting"
      emptyHint="Every submission is graded and no questions are open."
      action={summary && summary.total > 0 ? <Badge tone="warn">{summary.total}</Badge> : null}
      footer={summary?.scopedNote ? <span className="tiny faint">{summary.scopedNote}</span> : null}
    >
      <div className="col" style={{ gap: 4 }}>
        {live.map((row) => (
          <button
            key={row.id}
            className="cc-row"
            onClick={() => row.action && onAction(row.action)}
            disabled={!row.action}
          >
            <span aria-hidden="true" style={{ fontSize: 17 }}>
              <Icon name={ICON[row.kind]} size={17} />
            </span>

            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
                <span className="cc-row-title">{row.label}</span>
                <Badge tone={PRIORITY_TONE[row.priority]}>{row.priority}</Badge>
              </div>
              <div className="cc-row-meta">{row.detail}</div>
            </div>

            <span className="cc-row-count">{row.count}</span>
          </button>
        ))}

        {blocked.map((row) => (
          <div key={row.id} style={{ marginTop: 8 }}>
            <CapabilityNotice capability={CAPABILITIES[row.capability]} compact />
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}
