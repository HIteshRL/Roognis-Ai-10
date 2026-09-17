import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../../components/ui'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { EvidenceViewer } from '../../shared/components/EvidenceViewer'
import { PriorityBadge } from '../../shared/components/PriorityBadge'
import type { SuggestedAction } from '../../shared/types/common'
import type { Recommendation } from '../types/dashboard'

/**
 * One recommendation, collapsed to a claim and expandable to its reasoning.
 *
 * The expansion is not decoration: §7 requires that a recommendation can
 * produce the evidence and the rule version behind it, and this is where a
 * teacher checks whether to believe it before acting.
 */
export function RecommendationCard({
  recommendation,
  onAction,
}: {
  recommendation: Recommendation
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailsId = `rec-detail-${recommendation.id.replace(/[^\w-]/g, '')}`

  return (
    <article
      className="card"
      style={{ padding: '14px 16px', background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}
    >
      <div className="spread" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
            <PriorityBadge priority={recommendation.priority} />
            <Badge>{recommendation.classroomName}</Badge>
          </div>
          <h3 style={{ fontSize: 14.5 }}>{recommendation.title}</h3>
          <p className="small muted" style={{ margin: '5px 0 0' }}>
            {expanded ? recommendation.explanation : recommendation.summary}
          </p>
        </div>
        <ConfidenceBadge confidence={recommendation.confidence} compact />
      </div>

      {expanded && (
        <div id={detailsId} className="col" style={{ gap: 12, marginTop: 13 }}>
          <div>
            <div className="tiny" style={{ fontWeight: 700, marginBottom: 3 }}>
              How this was worked out
            </div>
            <div className="tiny muted">{recommendation.method}</div>
          </div>
          <EvidenceViewer
            evidence={recommendation.evidence}
            provenance={recommendation.provenance}
          />
        </div>
      )}

      <div className="row" style={{ gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
        {recommendation.primaryAction && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onAction(recommendation.primaryAction as SuggestedAction)}
          >
            {recommendation.primaryAction.label}
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          {expanded ? 'Hide reasoning' : 'Why?'}
        </button>
        <Link className="btn btn-ghost btn-sm" to={`/inbox/${encodeURIComponent(recommendation.insightId)}`}>
          Details
        </Link>
      </div>
    </article>
  )
}
