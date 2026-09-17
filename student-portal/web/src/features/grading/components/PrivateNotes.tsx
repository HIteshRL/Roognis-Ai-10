import { useEffect, useState } from 'react'
import { useToast } from '../../../components/ui'
import { createComment, listComments } from '../../shared/services/lmsService'
import type { Comment } from '../../shared/types/lms'
import { fmtDateTime } from '../../../lib/format'

/**
 * A private teacher↔student thread on one submission (Sprint 2, P3).
 * Never shown alongside the general class discussion; the server enforces
 * this is only reachable by a teacher of the class or the submission's own
 * student (`discussions.py`).
 *
 * Sprint 4, P3: promoted out of `CourseworkDetail.jsx` (S4.0 deliberately
 * left this file's `api.get` calls unfixed since this component was moving
 * here anyway) and routed through `lmsService` instead of a raw `api.get` —
 * frozen contract C11.
 */
export function PrivateNotes({
  classroomId,
  submissionId,
}: {
  classroomId: string
  submissionId: string
}): JSX.Element {
  const toast = useToast()
  const [notes, setNotes] = useState<readonly Comment[] | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setLoadError(null)
    try {
      setNotes(await listComments(classroomId, { submissionId }))
    } catch (e) {
      const error = e as Error
      toast.error(error.message)
      setLoadError(error)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId])

  const send = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await createComment(classroomId, { body: text, submissionId })
      setText('')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ background: 'var(--surface-2)', padding: 12, marginTop: 12 }}>
      <div className="tiny faint" style={{ marginBottom: 8 }}>
        🔒 PRIVATE NOTES — only you and the teacher can see this
      </div>
      {loadError ? (
        <div className="small" style={{ color: 'var(--rose-500)', marginBottom: 8 }}>
          Couldn't load private notes.{' '}
          <button className="btn btn-ghost btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      ) : notes === null ? (
        <div className="small muted">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 8 }}>
          No private notes yet.
        </div>
      ) : (
        <div className="col" style={{ gap: 6, marginBottom: 10 }}>
          {notes.map((n) => (
            <div key={n.id} className="card" style={{ padding: '8px 10px' }}>
              <div className="tiny faint">
                {n.authorName || n.authorId} · {fmtDateTime(n.createdAt)}
              </div>
              <div className="small">{n.body}</div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="Add a private note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  )
}
