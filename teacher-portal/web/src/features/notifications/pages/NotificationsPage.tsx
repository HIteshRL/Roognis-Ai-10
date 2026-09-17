import { useNavigate } from 'react-router-dom'
import { EmptyState, Loading } from '../../../components/ui'
import { relTime } from '../../../lib/format'
import { useQuery } from '../../shared/hooks/useQuery'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../shared/services/lmsService'
import type { LmsNotification } from '../../shared/types/lms'

function targetPath(n: LmsNotification): string | null {
  const data = n.data as { classroomId?: string; courseworkId?: string }
  if (data.classroomId && data.courseworkId) return `/classes/${data.classroomId}/work/${data.courseworkId}`
  if (data.classroomId) return `/classes/${data.classroomId}`
  return null
}

/** Sprint 1, T4.4 — the full notification list; the bell only shows the last 15. */
export default function NotificationsPage(): JSX.Element {
  const nav = useNavigate()
  const { status, data, error, refetch } = useQuery(
    ['lms', 'notifications', 'page'],
    () => listNotifications(50),
    { staleTime: 15_000 },
  )

  const items = data?.notifications ?? []

  const markAll = async () => {
    await markAllNotificationsRead()
    refetch()
  }

  const open = async (n: LmsNotification) => {
    if (!n.isRead) await markNotificationRead(n.id)
    refetch()
    const path = targetPath(n)
    if (path) nav(path)
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="spread" style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26 }}>Notifications</h1>
        {data && data.unreadCount > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={markAll}>Mark all read</button>
        )}
      </div>

      {status === 'error' ? (
        <EmptyState
          icon="warning"
          title="Couldn't load your notifications"
          hint={error?.message ?? 'The service did not respond.'}
          action={
            <button className="btn btn-outline btn-sm" onClick={() => refetch()}>
              Try again
            </button>
          }
        />
      ) : status === 'loading' || status === 'idle' ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon="check" title="You're all caught up" hint="Nothing to see here yet." />
      ) : (
        <div className="col" style={{ gap: 0 }}>
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => open(n)}
              className="card"
              style={{
                textAlign: 'left',
                padding: '14px 16px',
                marginBottom: 8,
                border: 'none',
                background: n.isRead ? 'var(--surface)' : 'var(--primary-soft)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
              {n.body && <div className="small muted" style={{ marginTop: 3 }}>{n.body}</div>}
              <div className="tiny faint" style={{ marginTop: 6 }}>{relTime(n.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
