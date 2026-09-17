// @ts-check
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Badge, Loading, useToast } from '../components/ui.jsx'
import { GradeHistoryPanel } from '../features/grading/components/GradeHistoryPanel'
import { GradingScreen } from '../features/grading/components/GradingScreen'
import { PrivateNotes } from '../features/grading/components/PrivateNotes'
import { canRevealGrade } from '../features/shared/services/withholding'
import {
  getCoursework,
  listStudentCoursework,
  saveCourseworkDraft,
  submitCoursework,
} from '../features/shared/services/lmsService'
import { dueLabel, fmtDateTime } from '../lib/format'

/** @typedef {import('../features/shared/types/lms').Coursework} Coursework */
/** @typedef {import('../features/shared/types/lms').Submission} Submission */

/** `Submission.content` is a loosely-typed JSON blob (`Record<string,
 * unknown>`) — this narrows the one key every consumer here actually reads.
 * @param {Submission | null | undefined} sub
 */
function submissionText(sub) {
  const value = sub?.content?.text
  return typeof value === 'string' ? value : ''
}

/** @param {{ classroomId: string, cwId: string }} props */
function StudentSubmit({ classroomId, cwId }) {
  const toast = useToast()
  const [cw, setCw] = useState(/** @type {Coursework | null} */ (null))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [prefilledSubId, setPrefilledSubId] = useState(/** @type {string | null} */ (null))

  const load = async () => {
    try {
      const list = await listStudentCoursework(classroomId)
      setCw(list.find((c) => c.id === cwId) || null)
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    }
  }
  useEffect(() => {
    load() // eslint-disable-next-line
  }, [cwId])

  // Pre-fill the editor from a saved draft or turned-in answer, once per
  // submission id — the guard keeps a later reload from clobbering text the
  // student is actively editing.
  useEffect(() => {
    const sub = cw?.mySubmission
    if (sub && sub.id !== prefilledSubId && sub.status !== 'returned') {
      setText(submissionText(sub))
      setPrefilledSubId(sub.id)
    }
  }, [cw, prefilledSubId])

  if (!cw) return <Loading />
  const sub = cw.mySubmission
  const isMaterial = cw.type === 'material'

  const save = async () => {
    setBusy(true)
    try {
      await saveCourseworkDraft(cwId, text)
      toast.success('Saved')
      load()
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await submitCoursework(cwId, text)
      toast.success('Turned in')
      load()
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <h3>Your work</h3>
      {sub && canRevealGrade(sub.status, true) ? (
        <div style={{ marginTop: 12 }}>
          <Badge tone="success">Graded · {sub.grade}{cw.maxPoints != null ? ` / ${cw.maxPoints}` : ''}</Badge>
          {sub.feedback && <div className="card" style={{ background: 'var(--surface-2)', padding: 12, marginTop: 12 }}><div className="tiny faint">Feedback</div>{sub.feedback}</div>}
          {submissionText(sub) && <div style={{ marginTop: 12, whiteSpace: 'pre-wrap' }} className="small muted">You wrote: {submissionText(sub)}</div>}
          <GradeHistoryPanel submissionId={sub.id} refreshKey={sub.gradedAt} />
        </div>
      ) : isMaterial ? (
        <p className="muted" style={{ marginTop: 8 }}>This is a reference material — nothing to turn in.</p>
      ) : (
        <>
          {/* Badge doesn't forward a `style` prop (see ui.d.ts) — the
              marginBottom these two carried was a silent no-op before this
              pass; wrapping is the fix rather than papering over the type
              error, though the textarea's own marginTop below already
              created equivalent visual spacing either way. */}
          {sub?.status === 'turned_in' && sub.isLate && <div style={{ marginBottom: 10 }}><Badge tone="danger">Late — you can resubmit until it’s graded</Badge></div>}
          {sub?.status === 'turned_in' && !sub.isLate && <div style={{ marginBottom: 10 }}><Badge tone="primary">Turned in — you can resubmit until it’s graded</Badge></div>}
          {sub?.status === 'draft' && <div style={{ marginBottom: 10 }}><Badge tone="warn">Draft saved</Badge></div>}
          <textarea className="textarea" style={{ marginTop: 12 }} placeholder="Type your answer…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="spread" style={{ marginTop: 10 }}>
            <span className="tiny faint">{sub?.status === 'turned_in' ? 'Resubmitting replaces your previous answer.' : 'Your teacher will be notified when you turn in.'}</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost" onClick={save} disabled={busy || !text.trim()}>Save</button>
              <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>{sub?.status === 'turned_in' ? 'Resubmit' : 'Turn in'}</button>
            </div>
          </div>
        </>
      )}
      {sub && !isMaterial && <PrivateNotes classroomId={classroomId} submissionId={sub.id} />}
    </div>
  )
}

export default function CourseworkDetail() {
  const params = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const isTeacher = user?.role === 'teacher'
  const [cw, setCw] = useState(/** @type {Coursework | null} */ (null))

  // useParams() types every param as possibly-undefined (react-router can't
  // know this route always supplies both), but this route
  // (/classes/:id/work/:cwId) is only ever registered with both present —
  // narrowing once here rather than threading `| undefined` through every
  // callback and child prop below.
  const id = /** @type {string} */ (params.id)
  const cwId = /** @type {string} */ (params.cwId)

  useEffect(() => {
    ;(async () => {
      try {
        if (isTeacher) {
          setCw(await getCoursework(cwId))
        } else {
          const list = await listStudentCoursework(id)
          setCw(list.find((c) => c.id === cwId) || null)
        }
      } catch (e) {
        toast.error(/** @type {Error} */ (e).message)
      }
    })() // eslint-disable-next-line
  }, [cwId])

  if (!cw) return <Loading />
  const due = dueLabel(cw.dueAt)

  return (
    <div style={{ maxWidth: 820 }}>
      <Link to={`/classes/${id}`} className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }}>← Back to class</Link>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <div className="spread">
          <div>
            <div className="row" style={{ gap: 10 }}>
              <h1 style={{ fontSize: 24 }}>{cw.title}</h1>
              <Badge tone="default" >{cw.type}</Badge>
              {cw.status === 'draft' && <Badge tone="warn">Draft</Badge>}
            </div>
            <div className="row small muted" style={{ gap: 14, marginTop: 8 }}>
              {cw.maxPoints != null && <span>🎯 {cw.maxPoints} points</span>}
              {cw.dueAt && <span>📅 {fmtDateTime(cw.dueAt)}</span>}
            </div>
          </div>
          {due && cw.type !== 'material' && <Badge tone={due.tone}>{due.text}</Badge>}
        </div>
        {cw.description && <div style={{ marginTop: 16, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{cw.description}</div>}
        {Array.isArray(cw.rubricCriteria) && cw.rubricCriteria.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="tiny faint" style={{ marginBottom: 6 }}>RUBRIC</div>
            <div className="col" style={{ gap: 6 }}>
              {cw.rubricCriteria.map((c, i) => (
                <div key={i} className="spread card" style={{ padding: '8px 12px', background: 'var(--surface-2)' }}>
                  <span className="small"><strong>{c.criterion}</strong>{c.description ? ` — ${c.description}` : ''}</span>
                  <Badge>{c.maxPoints} pts</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {isTeacher ? (
        <GradingScreen
          classroomId={id}
          courseworkId={cwId}
          maxPoints={cw.maxPoints}
          rubricCriteria={cw.rubricCriteria}
        />
      ) : (
        (cw.quizId ? <section className="learning-panel"><h2>Your assessed quiz</h2><p>Open the quiz to complete and submit your answers.</p><Link className="btn btn-primary" to={`/assessment/${cw.quizId}`}>Open quiz</Link></section> : <StudentSubmit classroomId={id} cwId={cwId} />)
      )}
    </div>
  )
}
