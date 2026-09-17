import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { EmptyState, Loading, Modal, useToast } from '../components/ui.jsx'
import { TodoPanel } from '../features/todo/components/TodoPanel'
import { attentionFor, buildClassroomAttention } from '../features/shared/services/classroomAttention'
import {
  bulkArchiveClassrooms,
  createClassroom,
  createTerm,
  getTeacherTodo,
  joinClassroomByCode,
  listTeacherClassrooms,
  listStudentClassrooms,
  listTerms,
} from '../features/shared/services/lmsService'
import { colorFor } from '../lib/format'

/** Server's own cap (`Query(ge=1, le=200)`) — fetch the full page rather
 * than the (previously nonexistent) default, so a teacher with a lot of
 * classes still sees an honest, bounded list instead of an unbounded one. */
const CLASSROOMS_PAGE_SIZE = 200

function ClassCard({ c, isTeacher, attention, selectMode, selected, onToggleSelect }) {
  const color = c.color || colorFor(c.id)
  const content = (
    <>
      <div style={{ background: color, height: 84, padding: '16px 18px', color: '#fff', position: 'relative' }}>
        <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.01em' }}>{c.name}</div>
        <div style={{ fontSize: 13, opacity: 0.92 }}>{c.subject}{c.section ? ` · ${c.section}` : ''}</div>
        <div className="avatar" style={{ position: 'absolute', right: 16, bottom: -19, background: '#fff', color, border: '2px solid var(--surface)' }}>
          {c.subject?.[0]?.toUpperCase() || 'C'}
        </div>
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(c.id)}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', top: 14, right: 14, width: 18, height: 18 }}
          />
        )}
      </div>
      <div style={{ padding: '24px 18px 16px', flex: 1 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: c.grade || attention.total > 0 ? 10 : 0 }}>
          {c.grade && <span className="badge">{c.grade}</span>}
          {isTeacher && attention.total > 0 && (
            <span className="badge badge-warn" title="Ungraded work, held grades, missing work, or pending enrollments">
              {attention.total} need{attention.total === 1 ? 's' : ''} you
            </span>
          )}
        </div>
        <div className="row muted small" style={{ gap: 16, marginTop: 4 }}>
          {isTeacher && <span>👥 {c.studentCount ?? 0} students</span>}
          <span>📖 {c.chapterCount ?? 0} chapters</span>
        </div>
      </div>
      {isTeacher && (
        <div className="row small" style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', gap: 8, color: 'var(--text-muted)' }}>
          <span>Join code</span>
          <code style={{ background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 6, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text)' }}>{c.joinCode}</code>
        </div>
      )}
    </>
  )
  const cardStyle = { overflow: 'hidden', display: 'flex', flexDirection: 'column' }
  return selectMode ? (
    <div
      className="card card-hover"
      style={{ ...cardStyle, cursor: 'pointer', outline: selected ? '2px solid var(--primary)' : 'none' }}
      onClick={() => onToggleSelect(c.id)}
    >
      {content}
    </div>
  ) : (
    <Link to={`/classes/${c.id}`} className="card card-hover" style={cardStyle}>
      {content}
    </Link>
  )
}

export default function Classrooms() {
  const { user } = useAuth()
  const toast = useToast()
  const isTeacher = user.role === 'teacher'
  const [items, setItems] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [terms, setTerms] = useState([])
  const [termFilter, setTermFilter] = useState('')
  const [showTermModal, setShowTermModal] = useState(false)
  const [termForm, setTermForm] = useState({})
  const [termBusy, setTermBusy] = useState(false)
  const [todo, setTodo] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(/** @type {Set<string>} */ (new Set()))
  const [archiving, setArchiving] = useState(false)

  const attentionByClassroom = buildClassroomAttention(todo)

  const load = async (filterTermId = termFilter) => {
    setLoadError(null)
    try {
      const data = isTeacher
        ? await listTeacherClassrooms(filterTermId || undefined, CLASSROOMS_PAGE_SIZE)
        : await listStudentClassrooms(filterTermId || undefined)
      setItems(data)
      if (isTeacher) {
        getTeacherTodo().then(setTodo).catch(() => setTodo(null))
      }
    } catch (e) {
      // Was `setItems([])` — indistinguishable from "you haven't joined a
      // class", which invited the wrong CTA ("Join a class") on an outage.
      toast.error(e.message)
      setLoadError(e)
    }
  }
  const loadTerms = async () => {
    try {
      setTerms(await listTerms())
    } catch (e) {
      toast.error(e.message)
    }
  }
  useEffect(() => {
    load()
    if (isTeacher) loadTerms() // eslint-disable-next-line
  }, [])

  const submitTerm = async () => {
    if (!termForm.name || !termForm.startDate || !termForm.endDate) {
      toast.error('Name, start date and end date are required')
      return
    }
    setTermBusy(true)
    try {
      await createTerm({
        name: termForm.name,
        startDate: new Date(termForm.startDate).toISOString(),
        endDate: new Date(termForm.endDate).toISOString(),
        isCurrent: !!termForm.isCurrent,
      })
      toast.success('Term created')
      setShowTermModal(false)
      setTermForm({})
      loadTerms()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setTermBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    try {
      if (isTeacher) {
        if (!form.name || !form.subject) throw new Error('Name and subject are required')
        await createClassroom(form)
        toast.success('Class created')
      } else {
        if (!form.joinCode) throw new Error('Enter a join code')
        await joinClassroomByCode(form.joinCode.trim().toUpperCase())
        toast.success('Joined class')
      }
      setShowModal(false)
      setForm({})
      load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const archiveSelected = async () => {
    if (selectedIds.size === 0) return
    setArchiving(true)
    try {
      const res = await bulkArchiveClassrooms({ classroomIds: [...selectedIds] })
      if (res.skipped.length > 0) {
        toast.error(`Archived ${res.archived.length}; skipped ${res.skipped.length} you don't own.`)
      } else {
        toast.success(`Archived ${res.archived.length} class${res.archived.length === 1 ? '' : 'es'}.`)
      }
      exitSelectMode()
      load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setArchiving(false)
    }
  }

  const archiveTerm = async () => {
    if (!termFilter) return
    const term = terms.find((t) => t.id === termFilter)
    setArchiving(true)
    try {
      const res = await bulkArchiveClassrooms({ termId: termFilter })
      toast.success(`Archived ${res.archived.length} class${res.archived.length === 1 ? '' : 'es'} in ${term?.name || 'this term'}.`)
      setTermFilter('')
      load('')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 22, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 26 }}>{isTeacher ? 'Your classes' : 'My classes'}</h1>
          <p className="muted" style={{ marginTop: 4 }}>{isTeacher ? 'Create and manage the classes you teach.' : 'Classes you’ve joined.'}</p>
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {terms.length > 0 && (
            <select
              className="input"
              value={termFilter}
              onChange={(e) => { setTermFilter(e.target.value); load(e.target.value) }}
            >
              <option value="">All terms</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.isCurrent ? ' (current)' : ''}</option>
              ))}
            </select>
          )}
          {isTeacher && termFilter && (
            <button className="btn btn-outline" onClick={archiveTerm} disabled={archiving}>
              Archive this term
            </button>
          )}
          {isTeacher && (
            <button className="btn btn-ghost" onClick={() => setShowTermModal(true)}>＋ New term</button>
          )}
          {isTeacher && items && items.length > 0 && (
            selectMode ? (
              <button className="btn btn-ghost" onClick={exitSelectMode}>Cancel</button>
            ) : (
              <button className="btn btn-outline" onClick={() => setSelectMode(true)}>Select</button>
            )
          )}
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            {isTeacher ? '＋ Create class' : '＋ Join class'}
          </button>
        </div>
      </div>

      {selectMode && (
        <div className="card card-pad spread" style={{ marginBottom: 18, background: 'var(--surface-2)' }}>
          <span className="small">{selectedIds.size} selected</span>
          <button className="btn btn-danger btn-sm" onClick={archiveSelected} disabled={archiving || selectedIds.size === 0}>
            Archive selected
          </button>
        </div>
      )}

      {!isTeacher && <div style={{ marginBottom: 22, maxWidth: 640 }}><TodoPanel /></div>}

      {loadError ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load your classes"
          hint={loadError.message || 'The service did not respond.'}
          action={<button className="btn btn-outline btn-sm" onClick={() => load()}>Try again</button>}
        />
      ) : items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon={isTeacher ? '🏫' : '🎒'}
          title={isTeacher ? 'No classes yet' : 'You haven’t joined a class'}
          hint={isTeacher ? 'Create your first class to start posting coursework.' : 'Ask your teacher for a join code.'}
          action={<button className="btn btn-primary" onClick={() => setShowModal(true)}>{isTeacher ? 'Create a class' : 'Join a class'}</button>}
        />
      ) : (
        <>
          {items.length >= CLASSROOMS_PAGE_SIZE && (
            <div className="tiny faint" style={{ marginBottom: 10 }}>
              Showing the first {CLASSROOMS_PAGE_SIZE} classes — you may have more.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18 }}>
            {items.map((c) => (
              <ClassCard
                key={c.id}
                c={c}
                isTeacher={isTeacher}
                attention={attentionFor(attentionByClassroom, c.id)}
                selectMode={selectMode}
                selected={selectedIds.has(c.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        </>
      )}

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={isTeacher ? 'Create a class' : 'Join a class'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>{isTeacher ? 'Create' : 'Join'}</button>
          </>
        }
      >
        {isTeacher ? (
          <div className="col" style={{ gap: 14 }}>
            <div className="field"><label>Class name *</label><input className="input" placeholder="Class 8 Science" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Subject *</label><input className="input" placeholder="Science" value={form.subject || ''} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
            <div className="row" style={{ gap: 14 }}>
              <div className="field grow"><label>Section</label><input className="input" placeholder="A" value={form.section || ''} onChange={(e) => setForm({ ...form, section: e.target.value })} /></div>
              <div className="field grow"><label>Grade</label><input className="input" placeholder="Grade 8" value={form.grade || ''} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></div>
            </div>
            {terms.length > 0 && (
              <div className="field">
                <label>Term</label>
                <select className="input" value={form.termId || ''} onChange={(e) => setForm({ ...form, termId: e.target.value || undefined })}>
                  <option value="">No term</option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}{t.isCurrent ? ' (current)' : ''}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="field">
            <label>Class join code</label>
            <input className="input" placeholder="e.g. ABC2345" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }} value={form.joinCode || ''} onChange={(e) => setForm({ ...form, joinCode: e.target.value })} />
            <span className="tiny faint">Ask your teacher for the 7-character code.</span>
          </div>
        )}
      </Modal>

      {isTeacher && (
        <Modal
          open={showTermModal}
          onClose={() => setShowTermModal(false)}
          title="Create a term"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowTermModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTerm} disabled={termBusy}>Create</button>
            </>
          }
        >
          <div className="col" style={{ gap: 14 }}>
            <div className="field"><label>Name *</label><input className="input" placeholder="2026-27" value={termForm.name || ''} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })} /></div>
            <div className="row" style={{ gap: 14 }}>
              <div className="field grow"><label>Start date *</label><input className="input" type="date" value={termForm.startDate || ''} onChange={(e) => setTermForm({ ...termForm, startDate: e.target.value })} /></div>
              <div className="field grow"><label>End date *</label><input className="input" type="date" value={termForm.endDate || ''} onChange={(e) => setTermForm({ ...termForm, endDate: e.target.value })} /></div>
            </div>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={!!termForm.isCurrent} onChange={(e) => setTermForm({ ...termForm, isCurrent: e.target.checked })} />
              <span>Set as the current term</span>
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}
