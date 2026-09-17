import { useState } from 'react'
import { Badge, EmptyState, Loading, Spinner } from '../../../components/ui'
import { useActionDispatch } from '../../workflows/hooks/useActionDispatch'
import { InboxGroup } from '../components/InboxGroup'
import { InsightDrawer } from '../components/InsightDrawer'
import { useAIInbox } from '../hooks/useAIInbox'
import type { AIInsight } from '../types/insight'

/**
 * AI Inbox — an operations centre, not a notification list.
 *
 * The difference is that every row states what was observed, how confident the
 * system is, which records it read, and what to do about it; and that every row
 * can be accepted or dismissed. A notification tells you something happened. An
 * insight tells you what to do and lets you disagree.
 */
export default function AIInbox(): JSX.Element {
  const inbox = useAIInbox()
  const dispatch = useActionDispatch()
  const [openInsight, setOpenInsight] = useState<AIInsight | null>(null)

  const loading = inbox.factsQuery.status === 'loading'
  const error = inbox.factsQuery.error

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <header className="page-head">
        <div>
          <h1>AI Inbox</h1>
          <div className="page-sub">
            What the system noticed across your classes, with the evidence behind it.
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {inbox.classrooms.length > 1 && (
            <select
              className="select"
              style={{ width: 'auto' }}
              value={inbox.classroomFilter}
              onChange={(event) => inbox.setClassroomFilter(event.target.value)}
              aria-label="Filter by class"
            >
              <option value="all">All classes</option>
              {inbox.classrooms.map((classroom) => (
                <option key={classroom.id} value={classroom.id}>
                  {classroom.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-outline btn-sm" onClick={inbox.refetch}>
            Rescan
          </button>
        </div>
      </header>

      <div className="row" style={{ gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
        <Badge tone={inbox.inbox && inbox.inbox.openCount > 0 ? 'primary' : 'success'}>
          {inbox.inbox?.openCount ?? 0} open
        </Badge>
        {inbox.resolvedCount > 0 && (
          <button
            className="chip"
            aria-pressed={inbox.showResolved}
            onClick={() => inbox.setShowResolved(!inbox.showResolved)}
          >
            {inbox.showResolved ? 'Hide' : 'Show'} {inbox.resolvedCount} resolved
          </button>
        )}
        {inbox.factsQuery.refreshing && (
          <span className="row tiny faint" style={{ gap: 6 }}>
            <Spinner size={12} /> rescanning
          </span>
        )}
      </div>

      {error ? (
        <EmptyState
          icon="warning"
          title="Couldn’t scan your classes"
          hint={error.message}
          action={
            <button className="btn btn-outline btn-sm" onClick={inbox.refetch}>
              Try again
            </button>
          }
        />
      ) : loading ? (
        <Loading label="Scanning your classes…" />
      ) : inbox.classrooms.length === 0 ? (
        <EmptyState
          icon="classroom"
          title="No classes to scan"
          hint="The inbox reads your classes' coursework and gradebooks."
        />
      ) : (
        <div>
          {(inbox.inbox?.groups ?? []).map((group) => (
            <InboxGroup
              key={group.spec.id}
              group={group}
              statusOf={inbox.statusOf}
              onAccept={inbox.accept}
              onDismiss={inbox.dismiss}
              onRestore={inbox.restore}
              onViewDetails={setOpenInsight}
              onAction={dispatch}
            />
          ))}

          <p className="tiny faint" style={{ marginTop: 18 }}>
            Every insight here is computed by deterministic rules over your own coursework and
            gradebook records — no language model is involved in detecting, scoring or ranking
            them. Insights that would need learner-model data are shown as the service they wait
            on.
          </p>
        </div>
      )}

      <InsightDrawer
        insight={openInsight}
        status={openInsight ? inbox.statusOf(openInsight.id) : 'open'}
        onClose={() => setOpenInsight(null)}
        onAccept={inbox.accept}
        onDismiss={inbox.dismiss}
        onAction={dispatch}
      />
    </div>
  )
}
