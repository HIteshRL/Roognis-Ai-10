import { useState } from 'react'
import { Badge, Icon } from '../../../components/ui'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { CAPABILITIES } from '../../shared/services/capability'
import type { SuggestedAction } from '../../shared/types/common'
import type { AIInsight, InsightGroupResult, InsightStatus } from '../types/insight'
import { AIInsightCard } from './AIInsightCard'

/**
 * A collapsible group of insights.
 *
 * Groups with content start open; groups that are only waiting on a backend
 * start closed, so an inbox of real work is not buried under notices about
 * services that do not exist yet.
 */
export function InboxGroup({
  group,
  statusOf,
  onAccept,
  onDismiss,
  onRestore,
  onViewDetails,
  onAction,
}: {
  group: InsightGroupResult
  statusOf: (insightId: string) => InsightStatus
  onAccept: (insight: AIInsight) => void
  onDismiss: (insight: AIInsight) => void
  onRestore: (insight: AIInsight) => void
  onViewDetails: (insight: AIInsight) => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const hasContent = group.insights.length > 0
  const [open, setOpen] = useState(hasContent)
  const bodyId = `inbox-group-${group.spec.id}`

  return (
    <section className="inbox-group">
      <button
        className="inbox-group-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="row" style={{ gap: 10, minWidth: 0 }}>
          <Icon name={group.spec.icon} size={17} />
          <span style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>{group.spec.label}</span>
            <span className="tiny faint" style={{ display: 'block' }}>
              {group.spec.description}
            </span>
          </span>
        </span>

        <span className="row" style={{ gap: 8 }}>
          {hasContent ? (
            <Badge tone="primary">{group.insights.length}</Badge>
          ) : group.unavailable.length > 0 ? (
            <Badge tone="warn">waiting</Badge>
          ) : (
            <Badge tone="success">clear</Badge>
          )}
          <span aria-hidden="true" className="faint">
            {open ? '▾' : '▸'}
          </span>
        </span>
      </button>

      {open && (
        <div id={bodyId}>
          {group.insights.map((insight) => (
            <AIInsightCard
              key={insight.id}
              insight={insight}
              status={statusOf(insight.id)}
              onAccept={onAccept}
              onDismiss={onDismiss}
              onRestore={onRestore}
              onViewDetails={onViewDetails}
              onAction={onAction}
            />
          ))}

          {!hasContent && group.unavailable.length === 0 && (
            <div className="insight tiny faint">Nothing to report in this group right now.</div>
          )}

          {group.unavailable.length > 0 && (
            <div className="insight col" style={{ gap: 10 }}>
              {group.unavailable.map((capability) => (
                <CapabilityNotice key={capability} capability={CAPABILITIES[capability]} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
