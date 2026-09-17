import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, Badge } from '../../../components/ui'
import { fmtDateTime, relTime } from '../../../lib/format'
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge'
import { EvidenceViewer } from '../../shared/components/EvidenceViewer'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { CAPABILITIES } from '../../shared/services/capability'
import type { SuggestedAction } from '../../shared/types/common'
import { EVENT_TYPES, type TimelineEvent } from '../types/timeline'
import { TimelineAttachment } from './TimelineAttachment'
import { TimelineComments } from './TimelineComments'

/** Body length past which the card clamps and offers "Read more". */
const CLAMP_CHARS = 280

/**
 * One timeline event.
 *
 * Every event type renders through this card, which is what keeps an
 * announcement, a published quiz and an AI insight visually one stream rather
 * than three widgets. The type only changes the icon, the tint and what the
 * expanded body contains.
 *
 * AI insight events expand into their evidence, so the reasoning behind a claim
 * is one click from the claim itself rather than on another page.
 */
export function TimelineCard({
  event,
  bookmarked,
  onToggleBookmark,
  onTogglePin,
  onAction,
  onPostNow,
  onEdit,
}: {
  event: TimelineEvent
  bookmarked: boolean
  onToggleBookmark: (eventId: string) => void
  onTogglePin: (event: TimelineEvent) => void
  onAction: (action: SuggestedAction) => void
  /** Only called for `canManageSchedule` events — a scheduled announcement. */
  onPostNow?: (event: TimelineEvent) => void
  onEdit?: (event: TimelineEvent) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const spec = EVENT_TYPES[event.type]
  const isLong = event.body.length > CLAMP_CHARS
  const bodyId = `tl-body-${event.id.replace(/[^\w-]/g, '')}`

  return (
    <article className="card tl-card" aria-labelledby={`${bodyId}-title`}>
      <div className="tl-card-head">
        <span className="tl-icon" style={{ background: spec.tint }} aria-hidden="true">
          {spec.icon}
        </span>

        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <h3 className="tl-title" id={`${bodyId}-title`}>
              {event.courseworkId ? (
                <Link to={`/classes/${event.classroomId}/work/${event.courseworkId}`}>
                  {event.title}
                </Link>
              ) : (
                event.title
              )}
            </h3>
            {event.isPinned && <Badge tone="warn">📌 Pinned</Badge>}
          </div>

          <div className="tl-meta">
            <span>{spec.label}</span>
            <span aria-hidden="true">·</span>
            <span className="row" style={{ gap: 5 }}>
              {event.author.role === 'system' ? (
                <span aria-hidden="true">🤖</span>
              ) : (
                <Avatar name={event.author.name} id={event.author.id} size="sm" />
              )}
              {event.author.name}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={event.timestamp} title={fmtDateTime(event.timestamp)}>
              {relTime(event.timestamp)}
            </time>
            {event.badges.map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
            {event.publishStatus === 'scheduled' && event.scheduledFor && (
              <Badge tone="primary">Scheduled for {fmtDateTime(event.scheduledFor)}</Badge>
            )}
          </div>
        </div>

        <div className="row" style={{ gap: 3 }}>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            aria-pressed={bookmarked}
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this'}
            title={bookmarked ? 'Remove bookmark' : 'Bookmark this'}
            onClick={() => onToggleBookmark(event.id)}
          >
            {bookmarked ? '🔖' : '📑'}
          </button>
          {event.canPin && (
            <button
              className="btn btn-ghost btn-icon btn-sm"
              aria-pressed={event.isPinned}
              aria-label={event.isPinned ? 'Unpin from the timeline' : 'Pin to the top'}
              title={event.isPinned ? 'Unpin' : 'Pin to the top'}
              onClick={() => onTogglePin(event)}
            >
              📌
            </button>
          )}
        </div>
      </div>

      {event.body && (
        <div
          className={`tl-body ${!expanded && isLong ? 'tl-body-clamped' : ''}`}
          id={bodyId}
        >
          {event.body}
        </div>
      )}

      {/* AI insight events carry their own reasoning inline. */}
      {event.insight && expanded && (
        <div className="tl-ai" style={{ flexDirection: 'column', gap: 11 }}>
          <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
            <span aria-hidden="true">🧠</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 650 }}>How this was worked out</div>
              <div className="small muted" style={{ marginTop: 2 }}>
                {event.insight.method}
              </div>
            </div>
            <ConfidenceBadge confidence={event.insight.confidence} />
          </div>
          <EvidenceViewer
            evidence={event.insight.evidence}
            provenance={event.insight.provenance}
          />
        </div>
      )}

      {/* Non-AI events would carry a generated summary; that endpoint is unbuilt. */}
      {!event.insight && expanded && event.body.length > CLAMP_CHARS && (
        <div style={{ margin: '11px 18px 0 66px' }}>
          <CapabilityNotice capability={CAPABILITIES['ai.event-summary']} compact />
        </div>
      )}

      {event.attachments.length > 0 && (
        <div
          className="row wrap"
          style={{ gap: 8, padding: '11px 18px 0 66px' }}
        >
          {event.attachments.map((attachment) => (
            <TimelineAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}

      <div className="tl-actions">
        {(isLong || event.insight) && (
          <button
            className="btn btn-ghost btn-sm"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Show less' : event.insight ? 'Why?' : 'Read more'}
          </button>
        )}

        {event.canComment && (
          <button
            className="btn btn-ghost btn-sm"
            aria-expanded={showComments}
            onClick={() => setShowComments((open) => !open)}
          >
            💬{' '}
            {event.commentCount === 0
              ? 'Comment'
              : `${event.commentCount} ${event.commentCount === 1 ? 'comment' : 'comments'}`}
          </button>
        )}

        {event.dueAt && (
          <span className="tiny faint" style={{ marginLeft: 4 }}>
            Due {fmtDateTime(event.dueAt)}
          </span>
        )}

        <span className="grow" />

        {event.canManageSchedule && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => onEdit?.(event)}>
              Edit
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => onPostNow?.(event)}>
              Post now
            </button>
          </>
        )}

        {event.insight?.actions.map((action) => (
          <button
            key={action.id}
            className={`btn btn-sm ${action.intent === 'primary' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>

      {showComments && event.canComment && <TimelineComments event={event} />}
    </article>
  )
}
