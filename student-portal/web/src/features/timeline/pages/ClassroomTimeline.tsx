import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { EmptyState, Loading, Spinner, useToast } from '../../../components/ui'
import { useAuth } from '../../../auth/AuthContext'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { useClassrooms } from '../../shared/hooks/useClassrooms'
import { CAPABILITIES } from '../../shared/services/capability'
import { useActionDispatch } from '../../workflows/hooks/useActionDispatch'
import { EditAnnouncementDialog } from '../components/EditAnnouncementDialog'
import { TimelineCard } from '../components/TimelineCard'
import { TimelineComposer } from '../components/TimelineComposer'
import { TimelineFilters } from '../components/TimelineFilters'
import { TimelineHeader } from '../components/TimelineHeader'
import { useTimeline } from '../hooks/useTimeline'
import type { TimelineEvent } from '../types/timeline'

/**
 * Classroom Timeline.
 *
 * One chronological stream over three sources the LMS keeps apart —
 * announcements, coursework and the deterministic insights — with sticky month
 * headers, day grouping, filter chips, search and infinite scroll.
 *
 * Paging happens over the merged set rather than per source, because the
 * sources have no shared cursor. That is a deliberate trade: it keeps ordering
 * correct at the cost of loading one announcement page up front, and the card
 * says so when that page is full.
 */
export default function ClassroomTimeline(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const toast = useToast()
  const dispatch = useActionDispatch()
  const classroomsQuery = useClassrooms()
  const isTeacher = user?.role === 'teacher'

  const classroom = classroomsQuery.data?.find((entry) => entry.id === id) ?? null
  const timeline = useTimeline(classroom, isTeacher)
  const [pinError, setPinError] = useState<string | null>(null)
  const [editingAnnouncement, setEditingAnnouncement] = useState<TimelineEvent | null>(null)

  useEffect(() => {
    if (pinError) {
      toast.error(pinError)
      setPinError(null)
    }
  }, [pinError, toast])

  if (classroomsQuery.status === 'loading') return <Loading label="Opening the class…" />

  if (!classroom) {
    return (
      <EmptyState
        icon="🔍"
        title="Class not found"
        hint="It may have been archived, or you may not be enrolled in it."
      />
    )
  }

  const loading =
    timeline.announcementsQuery.status === 'loading' || timeline.courseworkQuery.status === 'loading'
  const error = timeline.announcementsQuery.error ?? timeline.courseworkQuery.error

  return (
    <div style={{ maxWidth: 780, margin: '0 auto' }}>
      <TimelineHeader
        classroom={classroom}
        eventCount={timeline.allEvents.length}
        isTeacher={isTeacher}
        onRefresh={timeline.refetch}
      />

      {isTeacher && <TimelineComposer classroom={classroom} onAction={dispatch} />}

      <TimelineFilters
        filter={timeline.filter}
        counts={timeline.counts}
        search={timeline.search}
        onFilterChange={timeline.setFilter}
        onSearchChange={timeline.setSearch}
      />

      {error ? (
        <EmptyState
          icon="⚠️"
          title="Couldn’t load the timeline"
          hint={error.message}
          action={
            <button className="btn btn-outline btn-sm" onClick={timeline.refetch}>
              Try again
            </button>
          }
        />
      ) : loading ? (
        <Loading label="Building the timeline…" />
      ) : timeline.matchedCount === 0 ? (
        <EmptyState
          icon={timeline.allEvents.length === 0 ? '🌱' : '🔍'}
          title={timeline.allEvents.length === 0 ? 'Nothing here yet' : 'No matches'}
          hint={
            timeline.allEvents.length === 0
              ? isTeacher
                ? 'Post an announcement or publish some work to start the stream.'
                : 'Your teacher hasn’t posted anything yet.'
              : 'Try a different filter or search term.'
          }
          action={
            timeline.allEvents.length > 0 ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  timeline.setFilter('all')
                  timeline.setSearch('')
                }}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {timeline.months.map((month) => (
            <section key={month.month} aria-label={month.label}>
              <div className="tl-month">
                <span className="tl-month-label">{month.label}</span>
              </div>

              {month.days.map((day) => (
                <div key={day.date}>
                  <div className="tl-day">{day.label}</div>
                  <div className="col" style={{ gap: 12 }}>
                    {day.events.map((event) => (
                      <TimelineCard
                        key={event.id}
                        event={event}
                        bookmarked={timeline.isBookmarked(event.id)}
                        onToggleBookmark={timeline.toggleBookmark}
                        onTogglePin={(target) => {
                          void timeline.togglePin(target).catch((cause: unknown) => {
                            setPinError(cause instanceof Error ? cause.message : 'Could not pin')
                          })
                        }}
                        onAction={dispatch}
                        onPostNow={(event) => {
                          if (!event.announcementId) return
                          void timeline.postAnnouncementNow(event.announcementId)
                        }}
                        onEdit={(event) => setEditingAnnouncement(event)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}

          {/* Infinite scroll, with an explicit control beside it.
              The observer handles the common case; the button is what makes
              the rest of the timeline reachable by keyboard, and the fallback
              wherever IntersectionObserver does not run. */}
          {timeline.hasMore && (
            <div
              ref={timeline.sentinelRef}
              className="col"
              style={{ alignItems: 'center', padding: '22px 0', gap: 10 }}
            >
              <button className="btn btn-outline btn-sm" onClick={timeline.loadMore}>
                Load older events
              </button>
              <span className="row small muted" style={{ gap: 8 }}>
                <Spinner size={13} />
                Showing {timeline.shownCount} of {timeline.matchedCount}
              </span>
            </div>
          )}

          {!timeline.hasMore && (
            <div className="center tiny faint" style={{ padding: '22px 0' }}>
              {timeline.shownCount} of {timeline.matchedCount} events · that’s everything
            </div>
          )}
        </>
      )}

      {timeline.announcementsTruncated && (
        <div style={{ marginTop: 12 }}>
          <div className="cap-notice">
            <div className="small">
              <strong>Older announcements are not loaded.</strong> The LMS stream endpoint caps a
              page at 100 posts and has no cursor, so this timeline covers the most recent 100
              announcements plus all coursework. A cursor-paged stream endpoint would remove the
              limit.
            </div>
          </div>
        </div>
      )}

      {isTeacher && (
        <div style={{ marginTop: 12 }}>
          <CapabilityNotice capability={CAPABILITIES['lms.event-reactions']} compact />
        </div>
      )}

      {isTeacher && (
        <EditAnnouncementDialog
          open={editingAnnouncement}
          busy={timeline.editAnnouncementPending}
          onClose={() => setEditingAnnouncement(null)}
          onSave={(input) => {
            if (!editingAnnouncement?.announcementId) return
            void timeline.editAnnouncement(editingAnnouncement.announcementId, input).then((ok) => {
              if (ok) setEditingAnnouncement(null)
            })
          }}
        />
      )}
    </div>
  )
}
