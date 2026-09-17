import { useEffect, useState } from 'react'
import { getGradeHistory } from '../../shared/services/lmsService'
import type { GradeHistoryEntry } from '../../shared/types/lms'
import { fmtDateTime } from '../../../lib/format'

/**
 * The append-only `grade_history` audit trail (Sprint 2, P3), collapsed by
 * default since most submissions only have one grading event. `refreshKey`
 * (pass the submission's own `gradedAt`) forces a refetch on every grading
 * action, even while already open — otherwise re-grading a submission whose
 * history panel is already expanded would keep showing the stale list from
 * before the re-grade.
 *
 * Sprint 4, P3: promoted out of `CourseworkDetail.jsx`, routed through
 * `lmsService.getGradeHistory` instead of a raw `api.get` (frozen contract
 * C11).
 */
export function GradeHistoryPanel({
  submissionId,
  refreshKey,
}: {
  submissionId: string
  refreshKey?: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<readonly GradeHistoryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    setHistory(null)
    setLoadError(null)
    ;(async () => {
      try {
        const res = await getGradeHistory(submissionId)
        setHistory(res.history || [])
      } catch (e) {
        setLoadError(e as Error)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshKey, attempt, submissionId])

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} grade history
      </button>
      {open &&
        (loadError ? (
          <div className="small" style={{ color: 'var(--rose-500)', marginTop: 6 }}>
            Couldn't load grade history.{' '}
            <button className="btn btn-ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : history === null ? (
          <div className="small muted" style={{ marginTop: 6 }}>
            Loading…
          </div>
        ) : history.length === 0 ? (
          <div className="small muted" style={{ marginTop: 6 }}>
            No grades recorded yet.
          </div>
        ) : (
          <div className="col" style={{ gap: 4, marginTop: 6 }}>
            {history.map((h) => (
              <div key={h.id} className="small muted">
                {fmtDateTime(h.createdAt)} — graded {h.grade}
                {h.returned ? ' (returned)' : ' (not yet returned)'}
                {h.isBackfilled && ' · reconstructed from current state'}
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
