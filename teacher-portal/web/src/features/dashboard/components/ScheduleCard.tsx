import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../../components/ui'
import { parseApiDate } from '../../../lib/format'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { DashboardCard } from '../../shared/components/DashboardCard'
import { CAPABILITIES } from '../../shared/services/capability'
import type { AsyncStatus, SuggestedAction } from '../../shared/types/common'
import { countdownLabel } from '../services/dashboardService'
import type { TodaySchedule } from '../types/dashboard'

const timeOf = (iso: string): string =>
  parseApiDate(iso)?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ?? ''

/** Ticks once a minute so the countdown stays honest without a per-second timer. */
function useMinuteTick(): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return tick
}

export function ScheduleCard({
  schedule,
    status,
    error,
    refreshing,
    hasData,
  onRetry,
  onAction,
}: {
  schedule: TodaySchedule | null
  status: AsyncStatus
  error: Error | null
  refreshing: boolean
  hasData?: boolean
  onRetry: () => void
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const now = useMinuteTick()
  const today = new Date(now).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <DashboardCard
      title="Today"
      icon="calendar"
      subtitle={today}
      status={status}
      error={error}
      refreshing={refreshing}
      hasData={hasData}
      onRetry={onRetry}
      isEmpty={(schedule?.entries.length ?? 0) === 0}
      emptyIcon="classroom"
      emptyTitle="No classes yet"
      emptyHint="Create a class to start using the Command Center."
      action={
        schedule && schedule.totalDueToday > 0 ? (
          <Badge tone="warn">{schedule.totalDueToday} due today</Badge>
        ) : (
          <Badge tone="success">Nothing due today</Badge>
        )
      }
      maxBodyHeight={340}
      footer={
        <CapabilityNotice capability={CAPABILITIES['lms.timetable']} compact />
      }
    >
      <div className="col" style={{ gap: 4 }}>
        {(schedule?.entries ?? []).map((entry) => (
          <div key={entry.classroomId} className="cc-row" style={{ cursor: 'default' }}>
            <span
              aria-hidden="true"
              style={{
                width: 4,
                alignSelf: 'stretch',
                borderRadius: 999,
                background: entry.color,
                flex: 'none',
              }}
            />

            <div className="grow" style={{ minWidth: 0 }}>
              <Link to={`/classes/${entry.classroomId}`} className="cc-row-title">
                {entry.classroomName}
              </Link>
              <div className="cc-row-meta">
                {entry.subject ?? 'Class'}
                {entry.section ? ` · ${entry.section}` : ''} · {entry.studentCount} students
              </div>

              {entry.dueToday.length > 0 && (
                <div className="tiny" style={{ marginTop: 5, color: 'var(--text-muted)' }}>
                  {entry.dueToday.map((item) => (
                    <div key={item.courseworkId}>
                      {timeOf(item.dueAt)} · {item.title}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
              {entry.nextDueAt ? (
                <Badge tone="warn">due in {countdownLabel(entry.nextDueAt, now)}</Badge>
              ) : entry.dueToday.length > 0 ? (
                <Badge tone="default">closed today</Badge>
              ) : null}

              <div className="row" style={{ gap: 5 }}>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() =>
                    onAction({
                      id: `${entry.classroomId}:attendance`,
                      label: 'Attendance',
                      kind: 'take-attendance',
                      intent: 'secondary',
                      params: { classroomId: entry.classroomId },
                    })
                  }
                >
                  Attendance
                </button>
                <Link className="btn btn-primary btn-sm" to={`/classes/${entry.classroomId}/timeline`}>
                  Open
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}
