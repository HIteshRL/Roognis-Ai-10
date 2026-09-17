import { Link } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { Badge } from '../../../components/ui'
import { colorFor } from '../../../lib/format'
import type { Classroom } from '../../shared/types/lms'

/**
 * Class banner above the timeline.
 *
 * Uses the classroom's own colour, falling back to the deterministic palette
 * hash the rest of the app already uses for the same class, so a class looks
 * the same everywhere.
 */
export function TimelineHeader({
  classroom,
  eventCount,
  isTeacher,
  onRefresh,
}: {
  classroom: Classroom
  eventCount: number
  isTeacher: boolean
  onRefresh: () => void
}): JSX.Element {
  const color = classroom.color || colorFor(classroom.id)

  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 18 }}>
      <div
        className="timeline-header-band"
        style={{
          '--class-accent': color,
          padding: '24px 26px 20px',
          color: '#fff',
        } as CSSProperties}
      >
        <div className="spread" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <Link
              to={`/classes/${classroom.id}`}
              className="tiny"
              style={{ opacity: 0.85, textDecoration: 'underline' }}
            >
              ← Class overview
            </Link>
            <h1 style={{ fontSize: 26, marginTop: 6 }}>{classroom.name}</h1>
            <div style={{ opacity: 0.92, marginTop: 3, fontSize: 14 }}>
              {classroom.subject ?? 'Class'}
              {classroom.section ? ` · ${classroom.section}` : ''}
              {classroom.grade ? ` · Grade ${classroom.grade}` : ''}
              {classroom.studentCount !== undefined ? ` · ${classroom.studentCount} students` : ''}
            </div>
          </div>

          {isTeacher && classroom.joinCode && (
            <div style={{ textAlign: 'right' }}>
              <div className="tiny" style={{ opacity: 0.8 }}>
                Class code
              </div>
              <code style={{ fontSize: 19, fontWeight: 800, letterSpacing: '0.08em' }}>
                {classroom.joinCode}
              </code>
            </div>
          )}
        </div>
      </div>

      <div className="spread" style={{ padding: '11px 18px' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="primary">{eventCount} events</Badge>
          <span className="tiny faint">
            Announcements, coursework and AI insights in one chronological stream.
          </span>
        </div>
        <button className="btn btn-outline btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  )
}
