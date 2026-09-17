import { useEffect, useState } from 'react'
import { Badge, EmptyState, Icon, Loading } from '../../../components/ui'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { CAPABILITIES } from '../../shared/services/capability'
import { useActionDispatch } from '../../workflows/hooks/useActionDispatch'
import { InterventionDrawer } from '../components/InterventionDrawer'
import { StudentRiskCard } from '../components/StudentRiskCard'
import { useInterventions } from '../hooks/useInterventions'
import { RISK_CATEGORIES, type StudentRisk } from '../types/intervention'

/**
 * Student intervention queue.
 *
 * Grouped by what the teacher would do, ordered by severity, and every row
 * carries the evidence that put it there. A student appears in exactly one
 * group: the ruleset evaluates most-severe first and stops, so this is a
 * partition of the roster rather than five overlapping lists.
 */
export default function StudentIntervention(): JSX.Element {
  const interventions = useInterventions()
  const dispatch = useActionDispatch()
  const [openRisk, setOpenRisk] = useState<StudentRisk | null>(null)

  // A `?student=` link opens straight onto that student's reasoning.
  useEffect(() => {
    if (interventions.linkedRisk) setOpenRisk(interventions.linkedRisk)
  }, [interventions.linkedRisk])

  const { queue, factsQuery } = interventions
  const loading = factsQuery.status === 'loading'

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <header className="page-head">
        <div>
          <h1>Student intervention</h1>
          <div className="page-sub">
            {queue
              ? `${queue.all.length} of ${queue.studentCount} students flagged · ${queue.windowLabel.toLowerCase()}`
              : 'Who needs you, and what the records say'}
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {interventions.classrooms.length > 1 && (
            <select
              className="select"
              style={{ width: 'auto' }}
              value={interventions.classroom?.id ?? ''}
              onChange={(event) => interventions.setClassroomId(event.target.value)}
              aria-label="Class"
            >
              {interventions.classrooms.map((classroom) => (
                <option key={classroom.id} value={classroom.id}>
                  {classroom.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-outline btn-sm" onClick={interventions.refetch}>
            Refresh
          </button>
        </div>
      </header>

      <div className="col" style={{ gap: 11, marginBottom: 18 }}>
        <input
          className="input"
          type="search"
          value={interventions.search}
          placeholder="Find a student…"
          aria-label="Find a student"
          onChange={(event) => interventions.setSearch(event.target.value)}
        />

        <div className="chip-bar" role="group" aria-label="Filter by category">
          <button
            className="chip"
            aria-pressed={interventions.categoryFilter === 'all'}
            onClick={() => interventions.setCategoryFilter('all')}
          >
            All
            <span className="chip-count">{queue?.all.length ?? 0}</span>
          </button>
          {RISK_CATEGORIES.map((spec) => {
            const count = queue?.groups.find((group) => group.spec.id === spec.id)?.risks.length ?? 0
            return (
              <button
                key={spec.id}
                className="chip"
                aria-pressed={interventions.categoryFilter === spec.id}
                disabled={count === 0 && interventions.categoryFilter !== spec.id}
                onClick={() => interventions.setCategoryFilter(spec.id)}
              >
                <Icon name={spec.icon} size={17} />
                {spec.label}
                <span className="chip-count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {factsQuery.error ? (
        <EmptyState
          icon="warning"
          title="Couldn’t build the queue"
          hint={factsQuery.error.message}
          action={
            <button className="btn btn-outline btn-sm" onClick={interventions.refetch}>
              Try again
            </button>
          }
        />
      ) : loading ? (
        <Loading label="Reading the gradebook…" />
      ) : interventions.visibleGroups.length === 0 ? (
        <EmptyState
          icon="check"
          title={queue?.all.length ? 'No matches' : 'Nobody is flagged'}
          hint={
            queue?.all.length
              ? 'Try a different category or clear the search.'
              : 'No rule matched a student on the current evidence. That is a real result, not an empty screen.'
          }
        />
      ) : (
        <div className="col" style={{ gap: 22 }}>
          {interventions.visibleGroups.map((group) => (
            <section key={group.spec.id}>
              <div className="spread" style={{ marginBottom: 9 }}>
                <div className="row" style={{ gap: 9 }}>
                  <Icon name={group.spec.icon} size={17} />
                  <div>
                    <h2 style={{ fontSize: 15 }}>{group.spec.label}</h2>
                    <div className="tiny faint">{group.spec.description}</div>
                  </div>
                </div>
                <Badge tone="primary">{group.risks.length}</Badge>
              </div>

              {group.risks.map((risk) => (
                <div
                  key={risk.id}
                  style={interventions.isResolved(risk.id) ? { opacity: 0.55 } : undefined}
                >
                  <StudentRiskCard
                    risk={risk}
                    onAction={dispatch}
                    onOpenDetail={setOpenRisk}
                  />
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => interventions.toggleResolved(risk)}
                    >
                      {interventions.isResolved(risk.id)
                        ? 'Mark unresolved'
                        : 'Mark handled'}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <CapabilityNotice capability={CAPABILITIES['decisions.intervention-queue']} />
      </div>

      <InterventionDrawer risk={openRisk} onClose={() => setOpenRisk(null)} onAction={dispatch} />
    </div>
  )
}
