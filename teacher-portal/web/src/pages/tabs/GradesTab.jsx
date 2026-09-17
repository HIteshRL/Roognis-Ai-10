// @ts-check
import { useEffect, useState } from 'react'
import { EmptyState, Loading, useToast } from '../../components/ui.jsx'
import { getGradebook, getMissingWork } from '../../features/shared/services/lmsService'

/** @typedef {import('../../features/shared/types/lms').Gradebook} Gradebook */
/** @typedef {import('../../features/shared/types/lms').GradebookCell} GradebookCell */
/** @typedef {import('../../features/shared/types/lms').MissingWorkResponse} MissingWorkResponse */

/**
 * @param {GradebookCell | undefined} cell
 * @param {number | null} maxPoints
 */
function cellColor(cell, maxPoints) {
  if (!cell || cell.score == null) return {}
  if (!maxPoints) return {}
  const pct = cell.score / maxPoints
  if (pct >= 0.8) return { color: 'var(--emerald-600)', fontWeight: 700 }
  if (pct >= 0.5) return { color: 'var(--amber-500)', fontWeight: 700 }
  return { color: 'var(--rose-500)', fontWeight: 700 }
}

/**
 * Sprint 2, P4 — published, already-overdue coursework with the roster
 * students who still haven't turned it in. Collapsed by default: most
 * classes have nothing missing most of the time.
 * @param {{ classroomId: string }} props
 */
function MissingWork({ classroomId }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState(/** @type {MissingWorkResponse | null} */ (null))
  const [loadError, setLoadError] = useState(/** @type {Error | null} */ (null))
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open || report !== null) return
    setLoadError(null)
    ;(async () => {
      try {
        setReport(await getMissingWork(classroomId))
      } catch (e) {
        // Was toast-only, leaving `report` at null forever — the "Loading…"
        // branch below never had an exit, and `report !== null` above meant
        // a failed fetch would never even be retried by reopening the panel.
        const error = /** @type {Error} */ (e)
        toast.error(error.message)
        setLoadError(error)
      }
    })()
    // eslint-disable-next-line
  }, [open, attempt])

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <button
        className="spread"
        style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
        onClick={() => setOpen(!open)}
      >
        <strong>⚠️ Missing work</strong>
        <span className="small muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        loadError ? (
          <div className="small" style={{ padding: '0 16px 14px', color: 'var(--rose-500)' }}>
            Couldn't load missing work.{' '}
            <button className="btn btn-ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          </div>
        ) : report === null ? (
          <div className="small muted" style={{ padding: '0 16px 14px' }}>Loading…</div>
        ) : report.items.length === 0 ? (
          <div className="small muted" style={{ padding: '0 16px 14px' }}>Nothing overdue and unsubmitted right now.</div>
        ) : (
          <div className="col" style={{ gap: 10, padding: '0 16px 14px' }}>
            {report.items.map((item) => (
              <div key={item.courseworkId}>
                <div className="small" style={{ fontWeight: 700 }}>{item.title} · {item.missingCount} missing</div>
                <div className="tiny muted">
                  {item.missingStudents.map((s) => s.studentName).join(', ')}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

/** @param {{ classroom: import('../../features/shared/types/lms').Classroom }} props */
export default function GradesTab({ classroom }) {
  const toast = useToast()
  const [book, setBook] = useState(/** @type {Gradebook | null} */ (null))
  const [loadError, setLoadError] = useState(/** @type {Error | null} */ (null))

  const load = async () => {
    setLoadError(null)
    try {
      setBook(await getGradebook(classroom.id))
    } catch (e) {
      // Was toast-only with `book` left at null — a gradebook 500 spun the
      // loading state forever with no way to retry short of navigating away.
      const error = /** @type {Error} */ (e)
      toast.error(error.message)
      setLoadError(error)
    }
  }
  useEffect(() => {
    load() // eslint-disable-next-line
  }, [classroom.id])

  if (loadError) {
    return (
      <div>
        <EmptyState
          icon="⚠️"
          title="Couldn't load the gradebook"
          hint={loadError.message || 'The service did not respond.'}
          action={<button className="btn btn-outline btn-sm" onClick={load}>Try again</button>}
        />
      </div>
    )
  }
  if (!book) return <Loading />
  if (!book.columns.length || !book.rows.length) {
    return (
      <div>
        <MissingWork classroomId={classroom.id} />
        <EmptyState icon="📊" title="Nothing to grade yet" hint="Publish gradeable coursework and collect submissions to build the gradebook." />
      </div>
    )
  }

  return (
    <div>
      <MissingWork classroomId={classroom.id} />
      <div className="spread" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="card card-pad" style={{ padding: '10px 16px' }}><div className="tiny faint">Class average</div><div style={{ fontSize: 22, fontWeight: 800 }}>{book.classAveragePercent != null ? `${book.classAveragePercent}%` : '—'}</div></div>
          <div className="card card-pad" style={{ padding: '10px 16px' }}><div className="tiny faint">Students</div><div style={{ fontSize: 22, fontWeight: 800 }}>{book.studentCount}</div></div>
        </div>
        <a className="btn btn-outline" href={`/api/lms/classrooms/${classroom.id}/gradebook.csv`}>⬇ Export CSV</a>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '12px 16px', position: 'sticky', left: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)', minWidth: 160 }}>Student</th>
              {book.columns.map((c) => (
                <th key={c.courseworkId} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', textAlign: 'center', fontSize: 13, whiteSpace: 'nowrap' }}>
                  <div>{c.title}</div>
                  <div className="tiny faint" style={{ fontWeight: 500 }}>/ {c.maxPoints ?? '—'}</div>
                </th>
              ))}
              <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>Avg</th>
            </tr>
          </thead>
          <tbody>
            {book.rows.map((r) => (
              <tr key={r.studentId}>
                <td style={{ padding: '12px 16px', position: 'sticky', left: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>{r.studentName}</td>
                {book.columns.map((c) => {
                  const cell = r.cells[c.courseworkId]
                  return (
                    <td key={c.courseworkId} style={{ padding: '12px 14px', textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                      {cell && cell.score != null ? (
                        // `cell.returned` was computed by the backend and
                        // sent to every consumer but never read here — a
                        // withheld grade rendered visually identical to a
                        // returned one, so a teacher had no way to tell what
                        // the class had actually seen.
                        <span style={cellColor(cell, c.maxPoints)} title={cell.returned ? undefined : 'Graded but not yet returned to the student'}>
                          {cell.score}{!cell.returned && <sup style={{ color: 'var(--amber-500)', marginLeft: 2 }}>•</sup>}
                        </span>
                      ) : cell && cell.status === 'turned_in' ? (
                        <span className="tiny badge badge-primary">turned in</span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  )
                })}
                <td style={{ padding: '12px 16px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontWeight: 800 }}>{r.averagePercent != null ? `${r.averagePercent}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
