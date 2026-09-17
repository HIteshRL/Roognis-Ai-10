import { useState } from 'react'
import { useToast } from '../../../components/ui'
import {
  createRubric,
  deleteRubric,
  listMyRubrics,
  updateRubric,
} from '../../shared/services/lmsService'
import type { Rubric, RubricCriterion } from '../../shared/types/lms'

/**
 * Rubric authoring, embedded in the assignment-creation flow
 * (`ClassworkTab.jsx`'s `ClassworkFormModal`). Backend is
 * `services/lms/rubrics.py` — a rubric is just `{title, criteria}`, where
 * each criterion is a single `{criterion, description, maxPoints}` (no
 * nested point-level/descriptor grid; `GradingScreen.tsx` already renders
 * and scores exactly this flat shape via `Coursework.rubricCriteria`, so
 * this editor produces nothing that side doesn't already expect).
 *
 * This is the missing authoring half: create a rubric, or reuse one of the
 * teacher's own from `GET /lms/rubrics/mine` (Google-Classroom-style
 * reuse/copy), then attach it. `attachRubric` itself is called by the
 * parent on save (alongside the coursework create/update call), because a
 * newly-created draft coursework doesn't have an id yet until that call
 * returns — this component only ever hands back *which* rubric should be
 * attached, never calls attach itself.
 */

interface CriterionDraft {
  criterion: string
  description: string
  maxPoints: string
}

function draftFromCriteria(criteria: readonly RubricCriterion[] | undefined): CriterionDraft[] {
  if (!criteria || criteria.length === 0) {
    return [{ criterion: '', description: '', maxPoints: '' }]
  }
  return criteria.map((c) => ({
    criterion: c.criterion,
    description: c.description || '',
    maxPoints: String(c.maxPoints),
  }))
}

function rubricSummary(criteria: readonly RubricCriterion[]): string {
  const total = criteria.reduce((sum, c) => sum + (Number(c.maxPoints) || 0), 0)
  return `${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'} · ${total} pts`
}

/** Inline create/edit form for one rubric. `classroomId` is where a *new*
 * rubric gets created (`POST /lms/classrooms/{id}/rubrics` — a rubric is
 * always created inside one classroom); editing an existing rubric ignores
 * it and patches in place regardless of which classroom it lives in. */
function RubricEditorForm({
  classroomId,
  initial,
  onSaved,
  onCancel,
}: {
  classroomId: string
  initial: Rubric | null
  onSaved: (rubric: Rubric) => void
  onCancel: () => void
}): JSX.Element {
  const toast = useToast()
  const [title, setTitle] = useState(initial?.title || '')
  const [rows, setRows] = useState<CriterionDraft[]>(draftFromCriteria(initial?.criteria))
  const [busy, setBusy] = useState(false)

  const updateRow = (index: number, patch: Partial<CriterionDraft>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const addRow = (): void => setRows((prev) => [...prev, { criterion: '', description: '', maxPoints: '' }])
  const removeRow = (index: number): void => setRows((prev) => prev.filter((_, i) => i !== index))

  const save = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return toast.error('Rubric title is required')
    const criteria: RubricCriterion[] = []
    for (const row of rows) {
      const name = row.criterion.trim()
      if (!name) continue
      const points = Number(row.maxPoints)
      if (row.maxPoints === '' || Number.isNaN(points) || points < 0) {
        return toast.error(`Enter valid max points for "${name}"`)
      }
      criteria.push({ criterion: name, description: row.description.trim() || null, maxPoints: points })
    }
    if (criteria.length === 0) return toast.error('A rubric needs at least one criterion')

    setBusy(true)
    try {
      const rubric = initial
        ? await updateRubric(initial.id, { title: trimmedTitle, criteria })
        : await createRubric(classroomId, { title: trimmedTitle, criteria })
      toast.success(initial ? 'Rubric updated' : 'Rubric created')
      onSaved(rubric)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
      <div className="field">
        <label>Rubric title *</label>
        <input
          className="input"
          placeholder="Lab report rubric"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="col" style={{ gap: 10, marginTop: 12 }}>
        {rows.map((row, i) => (
          <div key={i} className="row wrap" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div className="field grow" style={{ minWidth: 160 }}>
              {i === 0 && <label>Criterion *</label>}
              <input
                className="input"
                placeholder="Argument quality"
                value={row.criterion}
                onChange={(e) => updateRow(i, { criterion: e.target.value })}
              />
            </div>
            <div className="field grow" style={{ minWidth: 180 }}>
              {i === 0 && <label>Description</label>}
              <input
                className="input"
                placeholder="What earns full marks here (optional)"
                value={row.description}
                onChange={(e) => updateRow(i, { description: e.target.value })}
              />
            </div>
            <div className="field" style={{ width: 90 }}>
              {i === 0 && <label>Max pts</label>}
              <input
                className="input"
                type="number"
                min="0"
                placeholder="10"
                value={row.maxPoints}
                onChange={(e) => updateRow(i, { maxPoints: e.target.value })}
              />
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: i === 0 ? 20 : 0 }}
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              aria-label="Remove criterion"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={addRow}>
        ＋ Add criterion
      </button>
      <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {initial ? 'Save changes' : 'Create rubric'}
        </button>
      </div>
    </div>
  )
}

export function RubricField({
  classroomId,
  attachedCriteria,
  selected,
  onSelectedChange,
  disabled,
}: {
  classroomId: string
  /** The rubric criteria already attached to this coursework item, if any
   * (edit mode only) — informational only; there's no rubric id to look up
   * on `Coursework`, so this can only be shown, not preselected as `selected`. */
  attachedCriteria?: readonly RubricCriterion[] | null
  /** The rubric chosen to attach when the assignment is saved. `null` means
   * "no change" — an already-attached rubric is left as-is (there is no
   * detach route on the backend). */
  selected: Rubric | null
  onSelectedChange: (rubric: Rubric | null) => void
  disabled?: boolean
}): JSX.Element {
  const toast = useToast()
  const [mode, setMode] = useState<'summary' | 'browse' | 'edit'>('summary')
  const [rubrics, setRubrics] = useState<readonly Rubric[] | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [editingRubric, setEditingRubric] = useState<Rubric | null>(null)

  const loadRubrics = async (): Promise<void> => {
    setLoadError(null)
    try {
      setRubrics(await listMyRubrics())
    } catch (e) {
      const error = e as Error
      toast.error(error.message)
      setLoadError(error)
    }
  }

  const openBrowse = (): void => {
    setMode('browse')
    if (rubrics === null) loadRubrics()
  }

  const useRubric = (rubric: Rubric): void => {
    onSelectedChange(rubric)
    setMode('summary')
  }

  const remove = async (rubric: Rubric, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm(`Delete rubric "${rubric.title}"? This cannot be undone.`)) return
    try {
      await deleteRubric(rubric.id)
      setRubrics((prev) => (prev ? prev.filter((r) => r.id !== rubric.id) : prev))
      if (selected?.id === rubric.id) onSelectedChange(null)
      toast.success('Rubric deleted')
    } catch (e2) {
      toast.error((e2 as Error).message)
    }
  }

  if (mode === 'edit') {
    return (
      <div className="field">
        <label>{editingRubric ? 'Edit rubric' : 'New rubric'}</label>
        <RubricEditorForm
          classroomId={classroomId}
          initial={editingRubric}
          onSaved={(rubric) => {
            useRubric(rubric)
            setEditingRubric(null)
          }}
          onCancel={() => setMode('browse')}
        />
      </div>
    )
  }

  if (mode === 'browse') {
    return (
      <div className="field">
        <label>My rubrics</label>
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          {loadError ? (
            <div className="small" style={{ color: 'var(--rose-500)' }}>
              Couldn't load rubrics.{' '}
              <button className="btn btn-ghost btn-sm" onClick={loadRubrics}>Retry</button>
            </div>
          ) : rubrics === null ? (
            <div className="small muted">Loading…</div>
          ) : rubrics.length === 0 ? (
            <div className="small muted" style={{ marginBottom: 8 }}>
              You haven't created a rubric yet.
            </div>
          ) : (
            <div className="col" style={{ gap: 6, marginBottom: 10 }}>
              {rubrics.map((r) => (
                <div
                  key={r.id}
                  className="spread card"
                  style={{ padding: '8px 12px', cursor: 'pointer' }}
                  onClick={() => useRubric(r)}
                >
                  <div>
                    <div className="small" style={{ fontWeight: 600 }}>{r.title}</div>
                    <div className="tiny faint">{rubricSummary(r.criteria)}</div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => { e.stopPropagation(); setEditingRubric(r); setMode('edit') }}
                    >
                      Edit
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={(e) => remove(r, e)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => { setEditingRubric(null); setMode('edit') }}
            >
              ＋ New rubric
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setMode('summary')}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // mode === 'summary'
  const displayCriteria = selected?.criteria ?? attachedCriteria ?? null
  const displayTitle = selected?.title ?? (attachedCriteria?.length ? 'Attached rubric' : null)

  return (
    <div className="field">
      <label>Rubric (optional)</label>
      {displayCriteria && displayCriteria.length > 0 ? (
        <div className="spread card" style={{ padding: '8px 12px', background: 'var(--surface-2)' }}>
          <div>
            <div className="small" style={{ fontWeight: 600 }}>{displayTitle}</div>
            <div className="tiny faint">{rubricSummary(displayCriteria)}</div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={openBrowse} disabled={disabled}>
            Change
          </button>
        </div>
      ) : (
        <button className="btn btn-outline btn-sm" onClick={openBrowse} disabled={disabled} style={{ alignSelf: 'flex-start' }}>
          ＋ Attach rubric
        </button>
      )}
    </div>
  )
}
