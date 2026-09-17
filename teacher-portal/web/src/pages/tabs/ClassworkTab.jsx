// @ts-check
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, EmptyState, Loading, Modal, useToast } from '../../components/ui.jsx'
import { RubricField } from '../../features/grading/components/RubricField'
import {
  assignCourseworkTopic,
  attachRubric,
  createCoursework,
  createTopic,
  deleteTopic,
  duplicateCoursework,
  listChapters,
  listClassroomStudents,
  listCoursework,
  listGroups,
  listStudentCoursework,
  listTopics,
  publishCoursework,
  updateCoursework,
  updateTopic,
  uploadAttachment,
} from '../../features/shared/services/lmsService'
import { dueLabel, fmtDate } from '../../lib/format'

/** @typedef {import('../../features/shared/types/lms').Coursework} Coursework */
/** @typedef {import('../../features/shared/types/lms').Submission} Submission */
/** @typedef {import('../../features/shared/types/lms').AnnouncementAttachment} AnnouncementAttachment */
/** @typedef {import('../../features/shared/types/lms').CourseworkType} CourseworkType */
/** @typedef {import('../../features/shared/types/lms').Chapter} Chapter */
/** @typedef {import('../../features/shared/types/lms').ClassroomGroup} ClassroomGroup */
/** @typedef {import('../../features/shared/types/lms').StudentMembership} StudentMembership */
/** @typedef {import('../../features/shared/types/lms').Rubric} Rubric */
/** @typedef {import('../../features/shared/types/lms').RubricCriterion} RubricCriterion */
/** @typedef {import('../../features/shared/types/lms').Topic} Topic */
/**
 * @typedef {{
 *   type: CourseworkType,
 *   title?: string,
 *   description?: string,
 *   maxPoints?: string,
 *   dueAt?: string,
 *   scheduledFor?: string,
 *   chapterId?: string,
 *   topicId?: string,
 *   allowResubmission?: boolean,
 * }} ClassworkForm
 */
/**
 * @typedef {{
 *   title: string,
 *   type: CourseworkType,
 *   description: string | null,
 *   maxPoints?: number,
 *   dueAt?: string,
 *   scheduledFor?: string,
 *   chapterId?: string,
 *   allowResubmission?: boolean,
 *   attachments?: readonly AnnouncementAttachment[],
 * }} CreateClassworkPayload
 */

/** @type {Record<string, string>} */
const TYPE_ICON = { assignment: '📝', quiz: '❓', question: '💬', material: '📎' }

/** @param {Submission | null | undefined} sub */
function statusBadge(sub) {
  if (!sub) return <Badge tone="default">Assigned</Badge>
  if (sub.status === 'returned') return <Badge tone="success">Graded{sub.grade != null ? ` · ${sub.grade}` : ''}</Badge>
  // Google-Classroom convention: red for late. isLate is recorded once at
  // turn-in time (services/lms/coursework.py::submit_coursework) and isn't
  // recomputed here, so a returned submission above still wins even if it
  // was originally late — grading feedback outranks the lateness flag.
  if (sub.status === 'turned_in' && sub.isLate) return <Badge tone="danger">Late</Badge>
  if (sub.status === 'turned_in') return <Badge tone="primary">Turned in</Badge>
  return <Badge>{sub.status}</Badge>
}

/**
 * @param {{
 *   open: ClassworkForm | null,
 *   title: string,
 *   busy: boolean,
 *   chapters: readonly Chapter[],
 *   attachments: readonly AnnouncementAttachment[],
 *   uploading: boolean,
 *   onClose: () => void,
 *   onChange: (form: ClassworkForm) => void,
 *   onSubmit: () => void,
 *   onAddFiles: (files: FileList | null) => void,
 *   onRemoveAttachment: (index: number) => void,
 *   submitLabel: string,
 *   showType: boolean,
 *   showAttachments: boolean,
 *   classroomId: string,
 *   attachedRubricCriteria: readonly RubricCriterion[] | null | undefined,
 *   selectedRubric: Rubric | null,
 *   onSelectedRubricChange: (rubric: Rubric | null) => void,
 *   topics: readonly Topic[],
 *   onCreateTopic: (name: string) => Promise<Topic | null>,
 * }} props
 */
function ClassworkFormModal({
  open, title, busy, chapters, attachments, uploading,
  onClose, onChange, onSubmit, onAddFiles, onRemoveAttachment, submitLabel, showType, showAttachments,
  classroomId, attachedRubricCriteria, selectedRubric, onSelectedRubricChange, topics, onCreateTopic,
}) {
  const form = open || /** @type {ClassworkForm} */ ({ type: 'assignment' })
  const [creatingTopic, setCreatingTopic] = useState(false)
  const [newTopicName, setNewTopicName] = useState('')
  const [savingTopic, setSavingTopic] = useState(false)

  // Resets whenever the modal opens for a different item — mirrors
  // PublishDialog's own reset-on-open effect below, since this component
  // stays mounted (only Modal's `open` toggles) across create/edit cycles.
  useEffect(() => {
    if (open) {
      setCreatingTopic(false)
      setNewTopicName('')
    }
    // eslint-disable-next-line
  }, [open])

  /** @param {string} value */
  const handleTopicSelect = (value) => {
    if (value === '__new__') {
      setCreatingTopic(true)
      return
    }
    onChange({ ...form, topicId: value || undefined })
  }

  const submitNewTopic = async () => {
    const name = newTopicName.trim()
    if (!name) return
    setSavingTopic(true)
    const topic = await onCreateTopic(name)
    setSavingTopic(false)
    if (topic) {
      onChange({ ...form, topicId: topic.id })
      setCreatingTopic(false)
      setNewTopicName('')
    }
  }

  return (
    <Modal
      open={open != null}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={busy}>{submitLabel}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="field"><label>Title *</label><input className="input" placeholder="Photosynthesis worksheet" value={form.title || ''} onChange={(e) => onChange({ ...form, title: e.target.value })} /></div>
        <div className="row wrap" style={{ gap: 14 }}>
          {showType && (
            <div className="field grow"><label>Type</label>
              <select className="select" value={form.type} onChange={(e) => onChange({ ...form, type: /** @type {CourseworkType} */ (e.target.value) })}>
                <option value="assignment">Assignment</option>
                <option value="quiz">Quiz</option>
                <option value="question">Question</option>
                <option value="material">Material</option>
              </select>
            </div>
          )}
          <div className="field grow"><label>Max points</label><input className="input" type="number" min="0" placeholder="10" value={form.maxPoints || ''} onChange={(e) => onChange({ ...form, maxPoints: e.target.value })} /></div>
        </div>
        <div className="row wrap" style={{ gap: 14 }}>
          <div className="field grow" style={{ minWidth: 160 }}><label>Due date</label><input className="input" type="datetime-local" value={form.dueAt || ''} onChange={(e) => onChange({ ...form, dueAt: e.target.value })} /></div>
          <div className="field grow">
            <label>Chapter</label>
            <select className="select" value={form.chapterId || ''} onChange={(e) => onChange({ ...form, chapterId: e.target.value || undefined })}>
              <option value="">None</option>
              {chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Topic</label>
            {creatingTopic ? (
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input"
                  placeholder="New topic name"
                  autoFocus
                  value={newTopicName}
                  onChange={(e) => setNewTopicName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitNewTopic() } if (e.key === 'Escape') setCreatingTopic(false) }}
                />
                <button type="button" className="btn btn-outline btn-sm" onClick={submitNewTopic} disabled={savingTopic || !newTopicName.trim()}>Add</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreatingTopic(false)}>Cancel</button>
              </div>
            ) : (
              <select className="select" value={form.topicId || ''} onChange={(e) => handleTopicSelect(e.target.value)}>
                <option value="">No topic</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__new__">＋ New topic…</option>
              </select>
            )}
          </div>
        </div>
        <div className="field"><label>Instructions</label><textarea className="textarea" placeholder="Describe the task…" value={form.description || ''} onChange={(e) => onChange({ ...form, description: e.target.value })} /></div>
        <div className="row wrap" style={{ gap: 14, alignItems: 'center' }}>
          <div className="field grow" style={{ minWidth: 200 }}><label>Schedule for (optional)</label><input className="input" type="datetime-local" value={form.scheduledFor || ''} onChange={(e) => onChange({ ...form, scheduledFor: e.target.value })} /></div>
          <label className="row" style={{ gap: 8, marginTop: 18 }}>
            <input
              type="checkbox"
              checked={form.allowResubmission ?? true}
              onChange={(e) => onChange({ ...form, allowResubmission: e.target.checked })}
            />
            <span className="small">Allow resubmission</span>
          </label>
        </div>
        {showAttachments && (
          <div className="field">
            <label>Attachments</label>
            <input
              className="input"
              type="file"
              multiple
              disabled={uploading}
              onChange={(e) => { onAddFiles(e.target.files); e.target.value = '' }}
            />
            <span className="tiny faint">PDF, Office docs, images or text, up to 20 MB each.</span>
            {uploading && <div className="small muted" style={{ marginTop: 6 }}>Uploading…</div>}
            {attachments.length > 0 && (
              <div className="col" style={{ gap: 6, marginTop: 8 }}>
                {attachments.map((a, i) => (
                  <div key={`${a.url}-${i}`} className="spread small" style={{ padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 8 }}>
                    <span>📎 {a.title}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => onRemoveAttachment(i)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <RubricField
          classroomId={classroomId}
          attachedCriteria={attachedRubricCriteria}
          selected={selectedRubric}
          onSelectedChange={onSelectedRubricChange}
          disabled={busy}
        />
      </div>
    </Modal>
  )
}

/**
 * Sprint 4, P2 (T2.4) — gives publish a real targeting choice instead of the
 * class-wide-only default every client sent before this. `publishCoursework`
 * has accepted `targetMode`/`studentIds`/`groupIds` since Sprint 3; nothing
 * called it with a body until now.
 * @param {{
 *   open: Coursework | null,
 *   students: readonly StudentMembership[],
 *   groups: readonly ClassroomGroup[],
 *   busy: boolean,
 *   onClose: () => void,
 *   onPublish: (input: { targetMode: 'all' | 'students', studentIds?: string[], groupIds?: string[] }) => void,
 * }} props
 */
function PublishDialog({ open, students, groups, busy, onClose, onPublish }) {
  const [mode, setMode] = useState(/** @type {'all' | 'students' | 'group'} */ ('all'))
  const [selectedStudents, setSelectedStudents] = useState(/** @type {Set<string>} */ (new Set()))
  const [selectedGroupId, setSelectedGroupId] = useState('')

  useEffect(() => {
    if (open) {
      setMode('all')
      setSelectedStudents(new Set())
      setSelectedGroupId(groups[0]?.id || '')
    }
    // eslint-disable-next-line
  }, [open])

  /** @param {string} id */
  const toggleStudent = (id) => {
    setSelectedStudents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = () => {
    if (mode === 'all') return onPublish({ targetMode: 'all' })
    if (mode === 'students') return onPublish({ targetMode: 'students', studentIds: [...selectedStudents] })
    if (mode === 'group' && selectedGroupId) return onPublish({ targetMode: 'students', groupIds: [selectedGroupId] })
  }

  const canSubmit =
    mode === 'all' ||
    (mode === 'students' && selectedStudents.size > 0) ||
    (mode === 'group' && !!selectedGroupId)

  return (
    <Modal
      open={open != null}
      onClose={onClose}
      title={`Publish “${open?.title || ''}”`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !canSubmit}>Publish</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <label className="row" style={{ gap: 8 }}><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /><span>Everyone in the class</span></label>
        <label className="row" style={{ gap: 8 }}><input type="radio" checked={mode === 'students'} onChange={() => setMode('students')} /><span>Selected students</span></label>
        {mode === 'students' && (
          <div className="col" style={{ gap: 6, maxHeight: 220, overflowY: 'auto', paddingLeft: 26 }}>
            {students.length === 0 ? (
              <span className="small muted">No students enrolled yet.</span>
            ) : students.map((s) => (
              <label key={s.studentId} className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={selectedStudents.has(s.studentId)} onChange={() => toggleStudent(s.studentId)} aria-label={`Select ${s.studentName || 'student'}`} />
                <span className="small">{s.studentName || s.studentId}</span>
              </label>
            ))}
          </div>
        )}
        <label className="row" style={{ gap: 8 }}><input type="radio" checked={mode === 'group'} onChange={() => setMode('group')} disabled={groups.length === 0} /><span>A group{groups.length === 0 ? ' (none created yet — see the People tab)' : ''}</span></label>
        {mode === 'group' && groups.length > 0 && (
          <select className="select" style={{ marginLeft: 26 }} value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.studentIds.length})</option>)}
          </select>
        )}
      </div>
    </Modal>
  )
}

/**
 * Topic management (rename/delete) — the "Manage topics" surface. Deleting a
 * topic does not delete or block its coursework: `topic_id` is a `SET NULL`
 * foreign key (`services/lms/models.py`; `topics.py::delete_topic` just
 * removes the row), so every item filed under it becomes un-filed rather
 * than being deleted or the delete being refused. The confirmation copy
 * below says exactly that, matching the backend rather than assuming a
 * block/cascade that doesn't exist.
 * @param {{
 *   open: boolean,
 *   topics: readonly Topic[],
 *   onClose: () => void,
 *   onCreate: (name: string) => Promise<Topic | null>,
 *   onRename: (topicId: string, name: string) => Promise<boolean>,
 *   onDelete: (topicId: string) => void,
 * }} props
 */
function TopicsManagerModal({ open, topics, onClose, onCreate, onRename, onDelete }) {
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState(/** @type {string | null} */ (null))
  const [renameValue, setRenameValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setNewName('')
      setRenamingId(null)
      setRenameValue('')
    }
    // eslint-disable-next-line
  }, [open])

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setSaving(true)
    const topic = await onCreate(name)
    setSaving(false)
    if (topic) setNewName('')
  }

  /** @param {Topic} t */
  const startRename = (t) => {
    setRenamingId(t.id)
    setRenameValue(t.name)
  }

  const submitRename = async () => {
    const name = renameValue.trim()
    if (!name || !renamingId) return
    setSaving(true)
    const ok = await onRename(renamingId, name)
    setSaving(false)
    if (ok) setRenamingId(null)
  }

  /** @param {Topic} t */
  const confirmDelete = (t) => {
    if (!window.confirm(`Delete topic "${t.name}"? Classwork filed under it will move to “Untopiced” — nothing is deleted.`)) return
    onDelete(t.id)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Manage topics"
      footer={<button className="btn btn-ghost" onClick={onClose}>Done</button>}
    >
      <div className="col" style={{ gap: 12 }}>
        {topics.length === 0 ? (
          <span className="small muted">No topics yet — create one below to start grouping classwork.</span>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {topics.map((t) => (
              <div key={t.id} className="spread" style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8, gap: 10 }}>
                {renamingId === t.id ? (
                  <input
                    className="input"
                    style={{ flex: 1, marginRight: 8 }}
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitRename() } if (e.key === 'Escape') setRenamingId(null) }}
                  />
                ) : (
                  <span className="small">{t.name}</span>
                )}
                <div className="row" style={{ gap: 6 }}>
                  {renamingId === t.id ? (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={submitRename} disabled={saving || !renameValue.trim()}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setRenamingId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => startRename(t)}>Rename</button>
                      <button className="btn btn-danger btn-sm" onClick={() => confirmDelete(t)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="New topic name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCreate() } }}
          />
          <button className="btn btn-outline btn-sm" onClick={submitCreate} disabled={saving || !newName.trim()}>Add</button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * @param {{
 *   classroom: import('../../features/shared/types/lms').Classroom,
 *   isTeacher: boolean,
 * }} props
 */
export default function ClassworkTab({ classroom, isTeacher }) {
  const nav = useNavigate()
  const toast = useToast()
  const [items, setItems] = useState(/** @type {readonly Coursework[] | null} */ (null))
  const [loadError, setLoadError] = useState(/** @type {Error | null} */ (null))
  const [chapters, setChapters] = useState(/** @type {readonly Chapter[]} */ ([]))
  const [groups, setGroups] = useState(/** @type {readonly ClassroomGroup[]} */ ([]))
  const [students, setStudents] = useState(/** @type {readonly StudentMembership[]} */ ([]))
  const [topics, setTopics] = useState(/** @type {readonly Topic[]} */ ([]))
  const [managingTopics, setManagingTopics] = useState(false)
  const [createForm, setCreateForm] = useState(/** @type {ClassworkForm | null} */ (null))
  const [editing, setEditing] = useState(/** @type {{ cw: Coursework, form: ClassworkForm } | null} */ (null))
  const [publishing, setPublishing] = useState(/** @type {Coursework | null} */ (null))
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState(/** @type {readonly AnnouncementAttachment[]} */ ([]))
  const [uploading, setUploading] = useState(false)
  /** Rubric chosen (created or reused via "My rubrics") to attach on save.
   * Separate from `createForm`/`editing.form` because a `Rubric` isn't part
   * of the coursework create/update payload — it's attached in a second call
   * (`attachRubric`) once the coursework item has an id. */
  const [createRubricSel, setCreateRubricSel] = useState(/** @type {Rubric | null} */ (null))
  const [editRubricSel, setEditRubricSel] = useState(/** @type {Rubric | null} */ (null))

  const load = async () => {
    setLoadError(null)
    try {
      const data = isTeacher
        ? await listCoursework(classroom.id)
        : await listStudentCoursework(classroom.id)
      setItems(data)
      // `list_topics` is readable by any classroom member (`require_member`,
      // not `require_teacher_of`), so the grouped view applies for students
      // too — fetched for both roles, unlike chapters/groups/students below
      // which are teacher-only management data.
      const tp = await listTopics(classroom.id).catch(() => [])
      setTopics(tp)
      if (isTeacher) {
        const [ch, gr, st] = await Promise.all([
          listChapters(classroom.id).catch(() => []),
          listGroups(classroom.id).catch(() => []),
          listClassroomStudents(classroom.id).catch(() => []),
        ])
        setChapters(ch)
        setGroups(gr)
        setStudents(st)
      }
    } catch (e) {
      // A failed fetch used to render as `items: []` — indistinguishable
      // from a class with genuinely nothing assigned. Keep `items` untouched
      // (so a retry after transient failure doesn't flash an empty list) and
      // render a distinct error state instead.
      const error = /** @type {Error} */ (e)
      toast.error(error.message)
      setLoadError(error)
    }
  }
  useEffect(() => {
    load() // eslint-disable-next-line
  }, [classroom.id])

  /** @param {ClassworkForm} form */
  const toPayload = (form) => {
    /** @type {CreateClassworkPayload} */
    const payload = { title: /** @type {string} */ (form.title), type: form.type, description: form.description || null }
    if (form.maxPoints) payload.maxPoints = Number(form.maxPoints)
    if (form.dueAt) payload.dueAt = new Date(form.dueAt).toISOString()
    if (form.scheduledFor) payload.scheduledFor = new Date(form.scheduledFor).toISOString()
    if (form.chapterId) payload.chapterId = form.chapterId
    if (form.allowResubmission === false) payload.allowResubmission = false
    if (attachments.length) payload.attachments = attachments
    return payload
  }

  const create = async () => {
    if (!createForm?.title) return toast.error('Title is required')
    setBusy(true)
    try {
      const created = await createCoursework(classroom.id, toPayload(createForm))
      if (createRubricSel) {
        try {
          await attachRubric(createRubricSel.id, created.id)
        } catch (e) {
          toast.error(`Created, but couldn't attach the rubric: ${/** @type {Error} */ (e).message}`)
        }
      }
      // `topicId` isn't part of `CreateCourseworkRequest` server-side (only
      // the legacy free-text `topic` is) — filing under a topic is always a
      // second call, once the coursework item has an id.
      if (createForm.topicId) {
        try {
          await assignCourseworkTopic(created.id, createForm.topicId)
        } catch (e) {
          toast.error(`Created, but couldn't file it under that topic: ${/** @type {Error} */ (e).message}`)
        }
      }
      toast.success('Coursework created as draft')
      setCreateForm(null)
      setAttachments([])
      setCreateRubricSel(null)
      load()
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    } finally {
      setBusy(false)
    }
  }

  /** @param {Coursework} cw */
  const startEdit = (cw) => {
    setEditRubricSel(null)
    setEditing({
      cw,
      form: {
        type: cw.type,
        title: cw.title,
        description: cw.description || '',
        maxPoints: cw.maxPoints != null ? String(cw.maxPoints) : '',
        dueAt: cw.dueAt ? cw.dueAt.slice(0, 16) : '',
        chapterId: cw.chapterId || undefined,
        topicId: cw.topicId || undefined,
        allowResubmission: cw.allowResubmission,
      },
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    setBusy(true)
    try {
      const { title, description, maxPoints, dueAt, chapterId, topicId, allowResubmission } = editing.form
      await updateCoursework(editing.cw.id, {
        title,
        description: description || null,
        maxPoints: maxPoints ? Number(maxPoints) : undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        chapterId: chapterId || undefined,
        allowResubmission,
      })
      // Same second-call shape as `create` above — reassign only when the
      // topic actually changed, and clear it (`topicId: null`) rather than
      // silently keeping the old one when the picker was set back to "No
      // topic" (`topicId` on the coursework record is `undefined` here).
      if (topicId !== (editing.cw.topicId || undefined)) {
        try {
          await assignCourseworkTopic(editing.cw.id, topicId || null)
        } catch (e) {
          toast.error(`Saved, but couldn't update its topic: ${/** @type {Error} */ (e).message}`)
        }
      }
      if (editRubricSel) {
        try {
          await attachRubric(editRubricSel.id, editing.cw.id)
        } catch (e) {
          toast.error(`Saved, but couldn't attach the rubric: ${/** @type {Error} */ (e).message}`)
        }
      }
      toast.success('Saved')
      setEditing(null)
      setEditRubricSel(null)
      load()
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * @param {Coursework} cw
   * @param {import('react').MouseEvent} e
   */
  const duplicate = async (cw, e) => {
    e.stopPropagation()
    try {
      await duplicateCoursework(cw.id)
      toast.success('Duplicated as a new draft')
      load()
    } catch (err) {
      toast.error(/** @type {Error} */ (err).message)
    }
  }

  /** @param {{ targetMode: 'all' | 'students', studentIds?: string[], groupIds?: string[] }} input */
  const confirmPublish = async (input) => {
    if (!publishing) return
    setBusy(true)
    try {
      await publishCoursework(publishing.id, input)
      toast.success('Published')
      setPublishing(null)
      load()
    } catch (err) {
      toast.error(/** @type {Error} */ (err).message)
    } finally {
      setBusy(false)
    }
  }

  /** @param {FileList | null} fileList */
  const addFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        const attachment = await uploadAttachment(file)
        setAttachments((prev) => [...prev, attachment])
      }
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    } finally {
      setUploading(false)
    }
  }

  /** @param {number} index */
  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  /**
   * Shared by `ClassworkFormModal`'s inline "+ New topic…" and
   * `TopicsManagerModal`'s create field. Errors are caught and toasted here
   * (rather than left to the caller) so both call sites can treat a `null`
   * return as "didn't work, leave the input as-is" without duplicating
   * try/catch.
   * @param {string} name
   * @returns {Promise<Topic | null>}
   */
  const handleCreateTopic = async (name) => {
    try {
      const topic = await createTopic(classroom.id, { name })
      setTopics((prev) => [...prev, topic].sort((a, b) => a.orderIndex - b.orderIndex))
      return topic
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
      return null
    }
  }

  /**
   * @param {string} topicId
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  const handleRenameTopic = async (topicId, name) => {
    try {
      const updated = await updateTopic(topicId, { name })
      setTopics((prev) => prev.map((t) => (t.id === topicId ? updated : t)))
      return true
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
      return false
    }
  }

  /** @param {string} topicId */
  const handleDeleteTopic = async (topicId) => {
    try {
      await deleteTopic(topicId)
      setTopics((prev) => prev.filter((t) => t.id !== topicId))
      // Mirrors the backend's SET NULL FK locally so the grouped list below
      // updates immediately without a full reload — matches what
      // `topics.py::delete_topic` actually does (un-file, never delete or
      // block).
      setItems((prev) => (prev ? prev.map((cw) => (cw.topicId === topicId ? { ...cw, topicId: null } : cw)) : prev))
      toast.success('Topic deleted')
    } catch (e) {
      toast.error(/** @type {Error} */ (e).message)
    }
  }

  /** Grouped-by-topic view of the flat `items` list — "Untopiced" first
   * (matching Google Classroom's own convention of floating ungrouped posts
   * to the top of the Classwork page), then topics in their `orderIndex`.
   * Only built once topics actually exist for this classroom; otherwise
   * `showTopicHeaders` below keeps the plain flat list so a class that
   * hasn't adopted topics isn't shown a lone "Untopiced" header. */
  const groupedItems = useMemo(() => {
    if (!items) return []
    const byTopicId = new Map(/** @type {[string, Coursework[]][]} */ ([]))
    const untopiced = /** @type {Coursework[]} */ ([])
    for (const cw of items) {
      if (cw.topicId) {
        const list = byTopicId.get(cw.topicId) || []
        list.push(cw)
        byTopicId.set(cw.topicId, list)
      } else {
        untopiced.push(cw)
      }
    }
    const groups = /** @type {{ id: string | null, name: string, items: Coursework[] }[]} */ ([])
    if (untopiced.length) groups.push({ id: null, name: 'Untopiced', items: untopiced })
    for (const t of topics) {
      const list = byTopicId.get(t.id)
      if (list?.length) groups.push({ id: t.id, name: t.name, items: list })
    }
    // A coursework item can reference a topic id this classroom's topic list
    // doesn't (yet) know about — e.g. a stale `load()` race right after
    // another tab deletes/renames one. Surface it under its own header
    // rather than silently dropping the item from the list.
    for (const [topicId, list] of byTopicId) {
      if (!topics.some((t) => t.id === topicId)) groups.push({ id: topicId, name: 'Topic', items: list })
    }
    return groups
  }, [items, topics])
  const showTopicHeaders = topics.length > 0

  return (
    <div style={{ maxWidth: 820 }}>
      {isTeacher && (
        <div className="spread" style={{ marginBottom: 16 }}>
          <p className="muted small">Assignments, quizzes and materials for this class.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-outline" onClick={() => setManagingTopics(true)}>Manage topics</button>
            <button className="btn btn-primary" onClick={() => setCreateForm({ type: 'assignment' })}>＋ Create</button>
          </div>
        </div>
      )}

      {loadError ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load classwork"
          hint={loadError.message || 'The service did not respond.'}
          action={<button className="btn btn-outline btn-sm" onClick={load}>Try again</button>}
        />
      ) : items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon="📚" title="No classwork yet" hint={isTeacher ? 'Create an assignment, quiz or material.' : 'Nothing has been assigned yet.'} />
      ) : (
        <div className="col" style={{ gap: 24 }}>
          {groupedItems.map((group) => (
            <div key={group.id ?? 'untopiced'} className="col" style={{ gap: 12 }}>
              {showTopicHeaders && (
                <div className="row" style={{ gap: 8, alignItems: 'baseline', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>{group.name}</h3>
                  <span className="tiny faint">{group.items.length}</span>
                </div>
              )}
              {group.items.map((cw) => {
                const due = dueLabel(cw.dueAt)
                return (
                  <div
                    key={cw.id}
                    className="card card-pad card-hover"
                    style={{ cursor: 'pointer' }}
                    role="link"
                    tabIndex={0}
                    onClick={() => nav(`/classes/${classroom.id}/work/${cw.id}`)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        nav(`/classes/${classroom.id}/work/${cw.id}`)
                      }
                    }}
                    aria-label={`Open ${cw.title}`}
                  >
                    <div className="spread wrap" style={{ rowGap: 10 }}>
                      <div className="row" style={{ gap: 14 }}>
                        <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--primary-soft)', display: 'grid', placeItems: 'center', fontSize: 20 }}>{TYPE_ICON[cw.type] || '📝'}</div>
                        <div>
                          <div style={{ fontWeight: 700 }}>{cw.title}</div>
                          <div className="row small muted" style={{ gap: 10, marginTop: 3 }}>
                            <span style={{ textTransform: 'capitalize' }}>{cw.type}</span>
                            {cw.maxPoints != null && <span>· {cw.maxPoints} pts</span>}
                            {cw.dueAt && <span>· Due {fmtDate(cw.dueAt)}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="row wrap" style={{ gap: 10 }}>
                        {isTeacher ? (
                          <>
                            {cw.status === 'draft' ? (
                              <>
                                <Badge tone="warn">Draft</Badge>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); startEdit(cw) }}>Edit</button>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => duplicate(cw, e)}>Duplicate</button>
                                <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); setPublishing(cw) }}>Publish</button>
                              </>
                            ) : cw.status === 'scheduled' ? (
                              <>
                                <Badge tone="primary">Scheduled{cw.scheduledFor ? ` · ${fmtDate(cw.scheduledFor)}` : ''}</Badge>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); startEdit(cw) }}>Edit</button>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => duplicate(cw, e)}>Duplicate</button>
                              </>
                            ) : (
                              <>
                                <span className="small muted">{cw.submissionStats?.turnedIn ?? 0} turned in · {cw.submissionStats?.graded ?? 0} graded</span>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); startEdit(cw) }}>Edit</button>
                                <button className="btn btn-ghost btn-sm" onClick={(e) => duplicate(cw, e)}>Duplicate</button>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            {due && cw.type !== 'material' && <Badge tone={due.tone}>{due.text}</Badge>}
                            {statusBadge(cw.mySubmission)}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <ClassworkFormModal
        open={createForm}
        title="Create classwork"
        busy={busy}
        chapters={chapters}
        attachments={attachments}
        uploading={uploading}
        onClose={() => { setCreateForm(null); setAttachments([]); setCreateRubricSel(null) }}
        onChange={setCreateForm}
        onSubmit={create}
        onAddFiles={addFiles}
        onRemoveAttachment={removeAttachment}
        submitLabel="Create draft"
        showType
        showAttachments
        classroomId={classroom.id}
        attachedRubricCriteria={null}
        selectedRubric={createRubricSel}
        onSelectedRubricChange={setCreateRubricSel}
        topics={topics}
        onCreateTopic={handleCreateTopic}
      />

      <ClassworkFormModal
        open={editing?.form ?? null}
        title={`Edit “${editing?.cw.title || ''}”`}
        busy={busy}
        chapters={chapters}
        attachments={[]}
        uploading={false}
        onClose={() => { setEditing(null); setEditRubricSel(null) }}
        onChange={(form) => setEditing((prev) => prev && { ...prev, form })}
        onSubmit={saveEdit}
        onAddFiles={() => {}}
        onRemoveAttachment={() => {}}
        submitLabel="Save changes"
        showType={false}
        showAttachments={false}
        classroomId={classroom.id}
        attachedRubricCriteria={editing?.cw.rubricCriteria}
        selectedRubric={editRubricSel}
        onSelectedRubricChange={setEditRubricSel}
        topics={topics}
        onCreateTopic={handleCreateTopic}
      />

      <PublishDialog
        open={publishing}
        students={students}
        groups={groups}
        busy={busy}
        onClose={() => setPublishing(null)}
        onPublish={confirmPublish}
      />

      <TopicsManagerModal
        open={managingTopics}
        topics={topics}
        onClose={() => setManagingTopics(false)}
        onCreate={handleCreateTopic}
        onRename={handleRenameTopic}
        onDelete={handleDeleteTopic}
      />
    </div>
  )
}
