import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, EmptyState, Icon } from '../../../components/ui'
import { fmtDate, parseApiDate } from '../../../lib/format'
import { InterventionDrawer } from '../../interventions/components/InterventionDrawer'
import { StudentRiskCard } from '../../interventions/components/StudentRiskCard'
import type { StudentRisk } from '../../interventions/types/intervention'
import { DashboardCard } from '../../shared/components/DashboardCard'
import { useActionDispatch } from '../../workflows/hooks/useActionDispatch'
import { CalendarMini } from '../components/CalendarMini'
import { PendingReviewCard } from '../components/PendingReviewCard'
import { QuickActionGrid } from '../components/QuickActionGrid'
import { RecommendationCard } from '../components/RecommendationCard'
import { ScheduleCard } from '../components/ScheduleCard'
import { useTeacherDashboard } from '../hooks/useTeacherDashboard'
import { QUICK_ACTIONS } from '../services/dashboardService'

const RISKS_ON_DASHBOARD = 5

/**
 * Teacher Command Center.
 *
 * The page answers one question — what needs this teacher right now — so it is
 * ordered by urgency, not by feature: what is happening today, what is waiting,
 * who needs help, what the system noticed, what is coming, and the six things a
 * teacher starts from.
 *
 * Panels load independently. One slow or failing service degrades its own card
 * and nothing else.
 */
export default function TeacherDashboard(): JSX.Element {
  const dashboard = useTeacherDashboard()
  const dispatch = useActionDispatch()
  const [openRisk, setOpenRisk] = useState<StudentRisk | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const topRisks = useMemo(
    () => dashboard.interventions?.all.slice(0, RISKS_ON_DASHBOARD) ?? [],
    [dashboard.interventions],
  )

  const visibleDeadlines = useMemo(
    () =>
      selectedDate
        ? dashboard.deadlines.filter((group) => group.date === selectedDate)
        : dashboard.deadlines,
    [dashboard.deadlines, selectedDate],
  )

  const focusedName = dashboard.focusedClassroom?.name ?? 'your class'

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Command Center</h1>
          <div className="page-sub">
            Everything waiting on you, ranked. Derived from your own classroom records.
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {dashboard.classrooms.length > 1 && (
            <label className="row" style={{ gap: 7 }}>
              <span className="tiny faint">Deep analysis for</span>
              <select
                className="select"
                style={{ width: 'auto' }}
                value={dashboard.focusedClassroom?.id ?? ''}
                onChange={(event) => dashboard.setFocusedClassroomId(event.target.value)}
                aria-label="Class for the intervention queue and recommendations"
              >
                {dashboard.classrooms.map((classroom) => (
                  <option key={classroom.id} value={classroom.id}>
                    {classroom.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn btn-outline btn-sm" onClick={dashboard.refetchAll}>
            Refresh
          </button>
        </div>
      </header>

      <div className="cc-grid">
        {/* A — Today */}
        <div className="cc-span-7">
          <ScheduleCard
            schedule={dashboard.schedule}
            status={dashboard.todoQuery.status}
            error={dashboard.todoQuery.error ?? dashboard.classroomsQuery.error}
            refreshing={dashboard.todoQuery.refreshing}
            hasData={dashboard.todoQuery.data !== null}
            onRetry={dashboard.refetchAll}
            onAction={dispatch}
          />
        </div>

        {/* B — Pending reviews */}
        <div className="cc-span-5">
          <PendingReviewCard
            summary={dashboard.pendingReviews}
            status={dashboard.todoQuery.status}
            error={dashboard.todoQuery.error}
            refreshing={dashboard.todoQuery.refreshing || dashboard.factsQuery.refreshing}
            hasData={dashboard.todoQuery.data !== null}
            onRetry={dashboard.refetchAll}
            onAction={dispatch}
          />
        </div>

        {/* C — Intervention queue */}
        <div className="cc-span-7">
          <DashboardCard
            title="Students who need you"
            icon="intervention"
            subtitle={
              dashboard.interventions
                ? `${focusedName} · ${dashboard.interventions.windowLabel.toLowerCase()}`
                : focusedName
            }
            status={dashboard.factsQuery.status}
            error={dashboard.factsQuery.error}
            refreshing={dashboard.factsQuery.refreshing}
            hasData={dashboard.factsQuery.data !== null}
            onRetry={() => void dashboard.factsQuery.refetch()}
            isEmpty={topRisks.length === 0}
            emptyIcon="check"
            emptyTitle="No one is flagged"
            emptyHint={`No rule matched a student in ${focusedName} on the current evidence.`}
            action={
              dashboard.interventions && dashboard.interventions.all.length > 0 ? (
                <Link className="btn btn-ghost btn-sm" to="/interventions">
                  View all {dashboard.interventions.all.length}
                </Link>
              ) : null
            }
            footer={
              <span className="tiny faint">
                Ranked by severity, then confidence. Every row is backed by graded work you can open.
              </span>
            }
          >
            <div>
              {topRisks.map((risk) => (
                <StudentRiskCard
                  key={risk.id}
                  risk={risk}
                  onAction={dispatch}
                  onOpenDetail={setOpenRisk}
                  compact
                />
              ))}
            </div>
          </DashboardCard>
        </div>

        {/* D — Recommendations */}
        <div className="cc-span-5">
          <DashboardCard
            title="What the system noticed"
            icon="insights"
            subtitle={focusedName}
            status={dashboard.factsQuery.status}
            error={dashboard.factsQuery.error}
            refreshing={dashboard.factsQuery.refreshing}
            hasData={dashboard.factsQuery.data !== null}
            onRetry={() => void dashboard.factsQuery.refetch()}
            isEmpty={dashboard.recommendations.length === 0}
            emptyIcon="spark"
            emptyTitle="Nothing stands out"
            emptyHint="No class-level pattern crossed a threshold on the current evidence."
            action={
              dashboard.recommendationTotal > dashboard.recommendations.length ? (
                <Link className="btn btn-ghost btn-sm" to="/inbox">
                  +{dashboard.recommendationTotal - dashboard.recommendations.length} more
                </Link>
              ) : (
                <Link className="btn btn-ghost btn-sm" to="/inbox">
                  AI Inbox
                </Link>
              )
            }
          >
            <div className="col" style={{ gap: 10 }}>
              {dashboard.recommendations.map((recommendation) => (
                <RecommendationCard
                  key={recommendation.id}
                  recommendation={recommendation}
                  onAction={dispatch}
                />
              ))}
            </div>
          </DashboardCard>
        </div>

        {/* E — Deadlines */}
        <div className="cc-span-8">
          <DashboardCard
            title="Upcoming deadlines"
            icon="calendar"
            subtitle="Across every class you teach"
            status={dashboard.calendarQuery.status}
            error={dashboard.calendarQuery.error}
            refreshing={dashboard.calendarQuery.refreshing}
            hasData={dashboard.calendarQuery.data !== null}
            onRetry={() => void dashboard.calendarQuery.refetch()}
            isEmpty={visibleDeadlines.length === 0}
            emptyIcon="spark"
            emptyTitle={selectedDate ? 'Nothing due that day' : 'No deadlines ahead'}
            emptyHint={
              selectedDate
                ? 'Pick another day, or clear the selection.'
                : 'Nothing is due in the next three weeks.'
            }
            action={
              selectedDate ? (
                <button className="btn btn-ghost btn-sm" onClick={() => setSelectedDate(null)}>
                  Clear {fmtDate(selectedDate)}
                </button>
              ) : (
                <Link className="btn btn-ghost btn-sm" to="/calendar">
                  Full calendar
                </Link>
              )
            }
            maxBodyHeight={330}
          >
            <div className="col" style={{ gap: 14 }}>
              {visibleDeadlines.map((group) => (
                <div key={group.date}>
                  <div className="tl-day">{group.label}</div>
                  {group.items.map((item) => (
                    <Link
                      key={item.id}
                      className="cc-row"
                      to={`/classes/${item.classroomId}/work/${item.id}`}
                    >
                      <span aria-hidden="true" className="cc-row-type-icon">
                        <Icon name={item.type === 'quiz' ? 'check' : item.type === 'question' ? 'inbox' : 'library'} size={16} />
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="cc-row-title">{item.title}</div>
                        <div className="cc-row-meta">
                          {item.classroomName}
                          {item.maxPoints !== null ? ` · ${item.maxPoints} points` : ''}
                        </div>
                      </div>
                      <span className="tiny faint">
                        {parseApiDate(item.dueAt)?.toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </DashboardCard>
        </div>

        {/* E — Mini calendar */}
        <div className="cc-span-4">
          <DashboardCard
            title="Calendar"
            icon="calendar"
            subtitle="Days carrying deadlines"
            status={dashboard.calendarQuery.status}
            error={dashboard.calendarQuery.error}
            refreshing={dashboard.calendarQuery.refreshing}
            hasData={dashboard.calendarQuery.data !== null}
            onRetry={() => void dashboard.calendarQuery.refetch()}
          >
            <CalendarMini
              calendar={dashboard.calendarQuery.data}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
          </DashboardCard>
        </div>

        {/* F — Quick actions */}
        <div className="cc-span-12">
          <DashboardCard
            title="Start something"
            icon="spark"
            subtitle="Each one runs a full workflow, not just a form"
            action={<Badge tone="primary">{QUICK_ACTIONS.length} actions</Badge>}
          >
            {dashboard.classrooms.length === 0 ? (
              <EmptyState
                icon="classroom"
                title="Create a class first"
                hint="Quick actions need somewhere to publish to."
                action={
                  <Link className="btn btn-primary btn-sm" to="/classes">
                    Go to classes
                  </Link>
                }
              />
            ) : (
              <QuickActionGrid
                actions={QUICK_ACTIONS}
                classroomId={dashboard.focusedClassroom?.id ?? null}
                onAction={dispatch}
              />
            )}
          </DashboardCard>
        </div>
      </div>

      <InterventionDrawer risk={openRisk} onClose={() => setOpenRisk(null)} onAction={dispatch} />
    </div>
  )
}
