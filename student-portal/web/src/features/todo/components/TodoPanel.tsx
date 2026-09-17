import { Link } from 'react-router-dom'
import { Badge } from '../../../components/ui'
import { dueLabel, fmtDate } from '../../../lib/format'
import { DashboardCard } from '../../shared/components/DashboardCard'
import type { TodoItem } from '../../shared/types/lms'
import { useStudentTodo } from '../hooks/useStudentTodo'

function TodoRow({ item }: { item: TodoItem }): JSX.Element {
  const due = dueLabel(item.dueAt)
  return (
    <Link
      to={`/classes/${item.classroomId}/work/${item.courseworkId}`}
      className="row spread"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', gap: 10 }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="small" style={{ fontWeight: 600 }}>{item.title}</div>
        <div className="tiny faint">{item.classroomName}</div>
      </div>
      {due && <Badge tone={due.tone}>{due.text}</Badge>}
    </Link>
  )
}

function GradedRow({ item }: { item: TodoItem }): JSX.Element {
  return (
    <Link
      to={`/classes/${item.classroomId}/work/${item.courseworkId}`}
      className="row spread"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', gap: 10 }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="small" style={{ fontWeight: 600 }}>{item.title}</div>
        <div className="tiny faint">{item.classroomName}</div>
      </div>
      <Badge tone="success">
        {item.score}{item.maxPoints != null ? ` / ${item.maxPoints}` : ''}
      </Badge>
    </Link>
  )
}

function SubmittedRow({ item }: { item: TodoItem }): JSX.Element {
  return (
    <Link
      to={`/classes/${item.classroomId}/work/${item.courseworkId}`}
      className="row spread"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', gap: 10 }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="small" style={{ fontWeight: 600 }}>{item.title}</div>
        <div className="tiny faint">{item.classroomName}</div>
      </div>
      <span className="tiny faint">Submitted {fmtDate(item.turnedInAt)}</span>
    </Link>
  )
}

/** Sprint 1, T4.4 — student to-do panel, mounted on `/classes`. */
export function TodoPanel(): JSX.Element {
  const { status, data, error, refreshing, refetch } = useStudentTodo()

  const needsAttention = data ? [...data.dueToday, ...data.overdue] : []
  const upcoming = data?.upcoming ?? []
  const recentlySubmitted = data?.recentlySubmitted ?? []
  const recentlyGraded = data?.recentlyGraded ?? []

  return (
    <DashboardCard
      title="To-do"
      icon="✅"
      status={status}
      error={error}
      refreshing={refreshing}
      onRetry={refetch}
      isEmpty={
        needsAttention.length === 0 &&
        upcoming.length === 0 &&
        recentlySubmitted.length === 0 &&
        recentlyGraded.length === 0
      }
      emptyIcon="🎉"
      emptyTitle="Nothing due"
      emptyHint="You're caught up across every class."
    >
      <div className="col" style={{ gap: 18 }}>
        {needsAttention.length > 0 && (
          <div>
            <div className="tiny faint" style={{ marginBottom: 4 }}>DUE TODAY &amp; OVERDUE</div>
            {needsAttention.map((item) => (
              <TodoRow key={item.courseworkId} item={item} />
            ))}
          </div>
        )}
        {upcoming.length > 0 && (
          <div>
            <div className="tiny faint" style={{ marginBottom: 4 }}>UPCOMING</div>
            {upcoming.map((item) => (
              <TodoRow key={item.courseworkId} item={item} />
            ))}
          </div>
        )}
        {recentlySubmitted.length > 0 && (
          <div>
            <div className="tiny faint" style={{ marginBottom: 4 }}>AWAITING FEEDBACK</div>
            {recentlySubmitted.map((item) => (
              <SubmittedRow key={item.courseworkId} item={item} />
            ))}
          </div>
        )}
        {recentlyGraded.length > 0 && (
          <div>
            <div className="tiny faint" style={{ marginBottom: 4 }}>RECENTLY GRADED</div>
            {recentlyGraded.map((item) => (
              <GradedRow key={item.courseworkId} item={item} />
            ))}
          </div>
        )}
      </div>
    </DashboardCard>
  )
}
