import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Avatar, Badge, Loading, useToast } from '../../../components/ui'
import {
  bulkGradeSubmissions,
  gradeSubmission,
  listSubmissions,
  returnAllGraded,
} from '../../shared/services/lmsService'
import { isGradedNotReturned } from '../../shared/services/withholding'
import type { RubricCriterion, Submission, SubmissionsResponse } from '../../shared/types/lms'
import {
  applyGradedOptimistically,
  bulkSelectable,
  mergedRubricScores,
  nextIndex,
  orderForGrading,
  rubricTotal,
  toBulkPayload,
  validateGrade,
  type GradeDraft,
  type GradeDrafts,
} from '../services/gradingQueue'
import { GradeHistoryPanel } from './GradeHistoryPanel'
import { PrivateNotes } from './PrivateNotes'

/** Server default/cap for `GET .../submissions` (`main.py`: `le=200`). Fetch
 * the full cap up front rather than the server's own smaller default (100)
 * — a class over 100 previously truncated silently while `stats` still
 * reported the whole roster. */
const SUBMISSIONS_PAGE_SIZE = 200

function isUngraded(submission: Submission): boolean {
  return submission.status === 'turned_in' && submission.grade == null
}

function statusBadge(submission: Submission): JSX.Element {
  if (submission.status === 'returned') {
    return <Badge tone="success">Returned · {submission.grade}</Badge>
  }
  if (isGradedNotReturned(submission.status, submission.grade)) {
    return <Badge tone="warn">Graded · {submission.grade} — not yet returned</Badge>
  }
  if (submission.status === 'draft') {
    return <Badge tone="default">Draft — not turned in</Badge>
  }
  // Google-Classroom convention: red for late, same as missing — isLate is
  // a fact recorded at turn-in time (services/lms/coursework.py), not
  // recomputed here.
  if (submission.isLate) {
    return <Badge tone="danger">Late</Badge>
  }
  return <Badge tone="primary">Turned in</Badge>
}

function submissionText(sub: Submission | null | undefined): string {
  const value = sub?.content?.text
  return typeof value === 'string' ? value : ''
}

export function GradingScreen({
  classroomId,
  courseworkId,
  maxPoints,
  rubricCriteria,
}: {
  classroomId: string
  courseworkId: string
  maxPoints: number | null
  rubricCriteria: readonly RubricCriterion[] | null
}): JSX.Element {
  const toast = useToast()
  const [data, setData] = useState<SubmissionsResponse | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [drafts, setDrafts] = useState<GradeDrafts>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ungradedOnly, setUngradedOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [bulkErrors, setBulkErrors] = useState<readonly { submissionId: string; error: string }[]>([])

  const hasRubric = Array.isArray(rubricCriteria) && rubricCriteria.length > 0

  const load = async (): Promise<void> => {
    setLoadError(null)
    try {
      const res = await listSubmissions(courseworkId, { limit: SUBMISSIONS_PAGE_SIZE })
      setData(res)
      setSelectedId((current) =>
        current && res.submissions.some((s) => s.id === current) ? current : (res.submissions[0]?.id ?? null),
      )
    } catch (e) {
      const error = e as Error
      toast.error(error.message)
      setLoadError(error)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseworkId])

  const ordered = useMemo(() => (data ? orderForGrading(data.submissions) : []), [data])
  const visible = useMemo(
    () => (ungradedOnly ? ordered.filter(isUngraded) : ordered),
    [ordered, ungradedOnly],
  )
  const selectedIndex = visible.findIndex((s) => s.id === selectedId)
  const selected = selectedIndex >= 0 ? visible[selectedIndex] : null

  const moveSelection = (delta: number): void => {
    if (visible.length === 0) return
    const from = selectedIndex >= 0 ? selectedIndex : 0
    setSelectedId(visible[nextIndex(from, visible.length, delta)]?.id ?? null)
  }

  const draftFor = (submission: Submission): GradeDraft => drafts[submission.id] ?? {}
  const setDraft = (submissionId: string, patch: GradeDraft): void =>
    setDrafts((prev) => ({ ...prev, [submissionId]: { ...prev[submissionId], ...patch } }))

  /** Loaded so far more than the fetch window suggests a class this large
   * exists — an honest "there may be more" rather than silently truncating
   * (the window is capped at the server's own max, so there's no further
   * page to request without a real cursor; recorded as a known limit, not
   * hidden). */
  const mayHaveMore = (data?.submissions.length ?? 0) >= SUBMISSIONS_PAGE_SIZE

  const gradeAndAdvance = async (
    submission: Submission,
    options: { returnToStudent?: boolean } = {},
  ): Promise<void> => {
    const returnToStudent = options.returnToStudent ?? true
    const draft = draftFor(submission)
    setBusy(true)
    try {
      let result: Submission
      if (hasRubric && rubricCriteria) {
        const scores = mergedRubricScores(submission, draft)
        result = await gradeSubmission(submission.id, {
          rubricScores: rubricCriteria.map((c) => ({
            criterion: c.criterion,
            points: Number(scores[c.criterion] ?? 0),
          })),
          feedback: draft.feedback ?? submission.feedback ?? null,
          returnToStudent,
        })
      } else {
        const raw = draft.grade ?? (submission.grade != null ? String(submission.grade) : '')
        if (raw === '') {
          toast.error('Enter a grade')
          return
        }
        const value = Number(raw)
        const validation = validateGrade(value, maxPoints)
        if (!validation.valid) {
          toast.error(validation.error ?? 'Invalid grade')
          return
        }
        result = await gradeSubmission(submission.id, {
          grade: value,
          feedback: draft.feedback ?? submission.feedback ?? null,
          returnToStudent,
        })
      }
      setData((prev) => (prev ? applyGradedOptimistically(prev, [result]) : prev))
      setDrafts((prev) => {
        const { [submission.id]: _omit, ...rest } = prev
        return rest
      })
      toast.success(
        returnToStudent
          ? `Graded and returned to ${submission.studentName || 'student'}`
          : `Grade saved for ${submission.studentName || 'student'} — not yet returned`,
      )
      moveSelection(1)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const gradeAllShown = async (): Promise<void> => {
    if (!data || hasRubric) return
    const { items, errors } = toBulkPayload(bulkSelectable(visible), drafts, maxPoints)
    setBulkErrors(errors)
    if (errors.length > 0) {
      toast.error(`${errors.length} grade${errors.length === 1 ? '' : 's'} need fixing before bulk grading.`)
      return
    }
    if (items.length === 0) {
      toast.error('Enter at least one grade first.')
      return
    }
    setBusy(true)
    try {
      const res = await bulkGradeSubmissions(courseworkId, { grades: items, returnToStudent: true })
      setData((prev) => (prev ? applyGradedOptimistically(prev, res.graded) : prev))
      setDrafts((prev) => {
        const rest = { ...prev }
        for (const item of items) delete rest[item.submissionId]
        return rest
      })
      toast.success(`Graded and returned ${res.graded.length} submission${res.graded.length === 1 ? '' : 's'}.`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const returnAllHeld = async (): Promise<void> => {
    if (!data) return
    setBusy(true)
    try {
      const res = await returnAllGraded(courseworkId)
      if (res.returnedCount === 0) {
        toast.show('No held grades to return.')
        return
      }
      const idSet = new Set(res.submissionIds)
      const updated = data.submissions
        .filter((s) => idSet.has(s.id))
        .map((s) => ({ ...s, status: 'returned' as const }))
      setData((prev) => (prev ? applyGradedOptimistically(prev, updated) : prev))
      toast.success(`Returned ${res.returnedCount} held grade${res.returnedCount === 1 ? '' : 's'}.`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <div className="empty">
        <div className="empty-icon">⚠️</div>
        <div className="small">Couldn't load submissions. {loadError.message}</div>
        <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={load}>
          Try again
        </button>
      </div>
    )
  }
  if (!data) return <Loading />

  const heldCount = ordered.filter((s) => isGradedNotReturned(s.status, s.grade)).length

  return (
    <div>
      <div className="row wrap" style={{ gap: 12, marginBottom: 14, alignItems: 'center' }}>
        <Badge tone="primary">{data.stats.turnedIn} turned in</Badge>
        <Badge tone="success">{data.stats.graded} returned</Badge>
        <Badge tone="warn">{data.stats.gradedNotReturned} graded, not returned</Badge>
        <Badge tone="default">{data.stats.missing} missing</Badge>
        {mayHaveMore && (
          <span className="tiny faint">
            Showing the first {SUBMISSIONS_PAGE_SIZE} submissions loaded — this class may have more.
          </span>
        )}
      </div>

      <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
        <button
          className={`btn btn-sm ${ungradedOnly ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setUngradedOnly((v) => !v)}
        >
          {ungradedOnly ? 'Showing ungraded only' : 'Show ungraded only'}
        </button>
        {!hasRubric && (
          <button className="btn btn-outline btn-sm" onClick={gradeAllShown} disabled={busy}>
            Grade all shown
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={returnAllHeld} disabled={busy || heldCount === 0}>
          Return all held grades{heldCount > 0 ? ` (${heldCount})` : ''}
        </button>
      </div>

      {bulkErrors.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: 'var(--rose-500)' }}>
          <div className="small" style={{ color: 'var(--rose-500)', marginBottom: 6 }}>
            Fix these before bulk grading:
          </div>
          {bulkErrors.map((err) => (
            <div key={err.submissionId} className="tiny muted">
              {ordered.find((s) => s.id === err.submissionId)?.studentName || err.submissionId}: {err.error}
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📭</div>
          <div className="small">{ungradedOnly ? 'Nothing ungraded — nice work.' : 'No submissions yet.'}</div>
        </div>
      ) : (
        <div className="grading-layout">
          <div className="col grading-rail" role="listbox" aria-label="Submissions" style={{ gap: 6 }}>
            {visible.map((s) => (
              <button
                key={s.id}
                role="option"
                aria-selected={s.id === selectedId}
                className="card"
                style={{
                  padding: '8px 10px',
                  textAlign: 'left',
                  border: s.id === selectedId ? '2px solid var(--primary)' : undefined,
                  cursor: 'pointer',
                }}
                onClick={() => setSelectedId(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    moveSelection(1)
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveSelection(-1)
                  }
                }}
              >
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Avatar name={s.studentName} id={s.studentId} size="sm" />
                  <span className="small" style={{ fontWeight: 600 }}>
                    {s.studentName || s.studentId}
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>{statusBadge(s)}</div>
              </button>
            ))}
          </div>

          <div className="card card-pad" style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <SubmissionDetail
                key={selected.id}
                classroomId={classroomId}
                submission={selected}
                draft={draftFor(selected)}
                onDraftChange={(patch) => setDraft(selected.id, patch)}
                maxPoints={maxPoints}
                hasRubric={hasRubric}
                rubricCriteria={rubricCriteria}
                busy={busy}
                onSave={(options) => gradeAndAdvance(selected, options)}
              />
            ) : (
              <div className="small muted">Select a submission from the list.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SubmissionDetail({
  classroomId,
  submission,
  draft,
  onDraftChange,
  maxPoints,
  hasRubric,
  rubricCriteria,
  busy,
  onSave,
}: {
  classroomId: string
  submission: Submission
  draft: GradeDraft
  onDraftChange: (patch: GradeDraft) => void
  maxPoints: number | null
  hasRubric: boolean
  rubricCriteria: readonly RubricCriterion[] | null
  busy: boolean
  onSave: (options?: { returnToStudent?: boolean }) => void
}): JSX.Element {
  const isDraft = submission.status === 'draft'
  const scores = hasRubric ? mergedRubricScores(submission, draft) : {}
  const total = hasRubric && rubricCriteria ? rubricTotal(rubricCriteria, scores) : null

  /** Enter saves and advances; Shift/Ctrl/Alt/Meta+Enter and every other
   * key are left alone (no multi-line fields exist in this form). */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      onSave()
    }
  }

  return (
    <div onKeyDown={onKeyDown}>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <Avatar name={submission.studentName} id={submission.studentId} size="sm" />
          <strong>{submission.studentName || submission.studentId}</strong>
        </div>
        {statusBadge(submission)}
      </div>

      {submissionText(submission) && (
        <div
          className="card"
          style={{ background: 'var(--surface-2)', padding: 12, marginBottom: 12, whiteSpace: 'pre-wrap' }}
        >
          {submissionText(submission)}
        </div>
      )}

      {isDraft ? (
        <div className="small muted">Waiting for the student to turn this in — nothing to grade yet.</div>
      ) : hasRubric && rubricCriteria ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            {rubricCriteria.map((c) => (
              <div key={c.criterion} className="field" style={{ width: 140 }}>
                <label>
                  {c.criterion} / {c.maxPoints}
                </label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  max={c.maxPoints}
                  value={scores[c.criterion] ?? ''}
                  onChange={(e) => onDraftChange({ scores: { ...draft.scores, [c.criterion]: e.target.value } })}
                />
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
            <div className="field grow">
              <label>Feedback</label>
              <input
                className="input"
                placeholder="Nice work…"
                value={draft.feedback ?? submission.feedback ?? ''}
                onChange={(e) => onDraftChange({ feedback: e.target.value })}
              />
            </div>
            <span className="small muted">
              Total: {total}
              {maxPoints != null ? ` / ${maxPoints}` : ''}
            </span>
            <button className="btn btn-ghost" disabled={busy} onClick={() => onSave({ returnToStudent: false })}>
              Save without returning
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => onSave()}>
              Return grade
            </button>
          </div>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 120 }}>
            <label>Grade{maxPoints != null ? ` / ${maxPoints}` : ''}</label>
            <input
              className="input"
              type="number"
              min="0"
              value={draft.grade ?? submission.grade ?? ''}
              onChange={(e) => onDraftChange({ grade: e.target.value })}
            />
          </div>
          <div className="field grow">
            <label>Feedback</label>
            <input
              className="input"
              placeholder="Nice work…"
              value={draft.feedback ?? submission.feedback ?? ''}
              onChange={(e) => onDraftChange({ feedback: e.target.value })}
            />
          </div>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onSave({ returnToStudent: false })}>
            Save without returning
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => onSave()}>
            Return grade
          </button>
        </div>
      )}

      {(submission.status === 'returned' || submission.grade != null) && (
        <GradeHistoryPanel submissionId={submission.id} refreshKey={submission.gradedAt} />
      )}
      <PrivateNotes classroomId={classroomId} submissionId={submission.id} />
    </div>
  )
}
