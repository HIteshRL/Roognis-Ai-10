import { useEffect, useState } from 'react'
import { Avatar, EmptyState, Loading, Modal, useToast } from '../../components/ui.jsx'
import {
  addCoTeacher,
  addStudentToClassroom,
  approveEnrollment,
  createGroup,
  deleteGroup,
  getStudentClasses,
  inviteGuardian,
  inviteStudentByEmail,
  listClassroomStudents,
  listCoTeachers,
  listGroups,
  listPendingEnrollments,
  listStudentGuardians,
  listTeacherClassrooms,
  regenerateGuardianCode,
  rejectEnrollment,
  removeCoTeacher,
  removeGuardian,
  removeStudent,
  updateGroup,
} from '../../features/shared/services/lmsService'

/**
 * Sprint 4, P1 — the cross-class student lookup: "click a student in one
 * roster, see their other classes that you teach." `roster_ops.py::
 * get_student_classes` (Sprint 3) had zero frontend consumers until this.
 * @param {{
 *   student: { studentId: string, studentName: string | null } | null,
 *   currentClassroomId: string,
 *   onClose: () => void,
 * }} props
 */
function StudentClassesModal({ student, currentClassroomId, onClose }) {
  const toast = useToast()
  const [classes, setClasses] = useState(/** @type {readonly import('../../features/shared/types/lms').StudentClassEntry[] | null} */ (null))
  const [myClassrooms, setMyClassrooms] = useState(/** @type {readonly import('../../features/shared/types/lms').Classroom[]} */ ([]))
  const [addTarget, setAddTarget] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!student) return
    setClasses(null)
    setAddTarget('')
    Promise.all([getStudentClasses(student.studentId), listTeacherClassrooms()])
      .then(([res, all]) => {
        setClasses(res.classrooms)
        setMyClassrooms(all)
      })
      .catch((e) => toast.error(e.message))
    // eslint-disable-next-line
  }, [student])

  if (!student) return null

  const enrolledIds = new Set((classes || []).map((c) => c.classroomId))
  const addableClassrooms = myClassrooms.filter((c) => !enrolledIds.has(c.id))

  const addToClassroom = async () => {
    if (!addTarget) return
    setBusy(true)
    try {
      await addStudentToClassroom(addTarget, { studentId: student.studentId, studentName: student.studentName })
      toast.success('Added to class')
      const res = await getStudentClasses(student.studentId)
      setClasses(res.classrooms)
      setAddTarget('')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${student.studentName || student.studentId}'s classes`}
      footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}
    >
      <div className="col" style={{ gap: 12 }}>
        {classes === null ? (
          <Loading />
        ) : classes.length === 0 ? (
          <span className="small muted">Not found in any of your other classes.</span>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {classes.map((c) => (
              <div key={c.classroomId} className="spread card" style={{ padding: '8px 12px', background: 'var(--surface-2)' }}>
                <span className="small">
                  {c.name}{c.classroomId === currentClassroomId ? ' (this class)' : ''}
                  {c.isArchived ? ' · archived' : ''}
                </span>
                <span className="tiny faint">{c.subject}</span>
              </div>
            ))}
          </div>
        )}
        {addableClassrooms.length > 0 && (
          <div className="field">
            <label>Add to another section</label>
            <div className="row" style={{ gap: 8 }}>
              <select className="select" style={{ flex: 1 }} value={addTarget} onChange={(e) => setAddTarget(e.target.value)}>
                <option value="">Choose a class…</option>
                {addableClassrooms.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.section ? ` · ${c.section}` : ''}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" onClick={addToClassroom} disabled={!addTarget || busy}>Add</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * Teacher-facing guardian roster + redeemable-code generator for one
 * student — closes the gap the guardian-linking audit flagged: inviting a
 * guardian used to write an LMS-local row nothing ever consumed, with no
 * UI to generate or share anything at all. Mirrors the classroom join-code
 * pattern rather than an email flow (this codebase has no email-sending
 * infrastructure): "Generate code" produces a short, one-time-use, expiring
 * code the teacher shares directly (text, printed slip, whatever channel);
 * a parent redeems it from their own Guardian page.
 * @param {{
 *   student: { studentId: string, studentName: string | null } | null,
 *   onClose: () => void,
 * }} props
 */
function GuardiansModal({ student, onClose }) {
  const toast = useToast()
  const [guardians, setGuardians] = useState(/** @type {readonly import('../../features/shared/types/lms').Guardian[] | null} */ (null))
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    if (!student) return
    listStudentGuardians(student.studentId)
      .then(setGuardians)
      .catch((e) => {
        toast.error(e.message)
        setGuardians([])
      })
  }

  useEffect(() => {
    if (!student) return
    setGuardians(null)
    setEmail('')
    load()
    // eslint-disable-next-line
  }, [student])

  if (!student) return null

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('Code copied')
    } catch {
      toast.error('Could not copy automatically — select and copy the code by hand.')
    }
  }

  const submitInvite = async (e) => {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    try {
      await inviteGuardian(student.studentId, email.trim())
      setEmail('')
      toast.success('Code generated')
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async (guardianId) => {
    try {
      await regenerateGuardianCode(guardianId)
      toast.success('New code generated')
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const revoke = async (guardianId) => {
    try {
      await removeGuardian(guardianId)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${student.studentName || student.studentId}'s guardians`}
      footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}
    >
      <div className="col" style={{ gap: 14 }}>
        {guardians === null ? (
          <Loading />
        ) : guardians.length === 0 ? (
          <span className="small muted">No guardians invited yet.</span>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {guardians.map((g) => (
              <div key={g.id} className="card" style={{ padding: '10px 12px', background: 'var(--surface-2)' }}>
                <div className="spread">
                  <div>
                    <div className="small" style={{ fontWeight: 600 }}>{g.guardianEmail}</div>
                    <div className="tiny faint">
                      {g.status === 'active'
                        ? 'Linked'
                        : g.status === 'pending'
                          ? (g.codeExpired ? 'Code expired' : 'Awaiting redemption')
                          : g.status}
                    </div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => revoke(g.id)}>
                    {g.status === 'active' ? 'Unlink' : 'Cancel'}
                  </button>
                </div>
                {g.status === 'pending' && (
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <code
                      className="tiny"
                      style={{ padding: '4px 8px', background: 'var(--surface-1)', borderRadius: 6, letterSpacing: '0.08em' }}
                    >
                      {g.code}
                    </code>
                    <button className="btn btn-outline btn-sm" onClick={() => copyCode(g.code)}>Copy</button>
                    {g.codeExpired && (
                      <button className="btn btn-outline btn-sm" onClick={() => regenerate(g.id)}>New code</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <form onSubmit={submitInvite} className="field">
          <label>Invite a guardian</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              type="email"
              placeholder="guardian@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy ? 'Generating…' : 'Generate code'}
            </button>
          </div>
          <span className="tiny faint" style={{ marginTop: 4, display: 'block' }}>
            Share the code directly with the guardian — nothing is emailed automatically.
          </span>
        </form>
      </div>
    </Modal>
  )
}

/**
 * Sprint 4, P2 (T2.4) — groups' first UI at all (`groups.py`'s four routes
 * had zero references in `web/src` before this). A teacher-defined subset
 * of the roster for targeting coursework (`PublishDialog` in
 * `ClassworkTab.jsx`); membership has no effect on anything already
 * published (decision D9).
 * @param {{
 *   classroomId: string,
 *   students: readonly { studentId: string, studentName: string | null }[],
 *   groups: readonly import('../../features/shared/types/lms').ClassroomGroup[],
 *   onChange: () => void,
 * }} props
 */
function GroupsPanel({ classroomId, students, groups, onChange }) {
  const toast = useToast()
  const [editing, setEditing] = useState(/** @type {{ id: string | null, name: string, studentIds: Set<string> } | null} */ (null))
  const [busy, setBusy] = useState(false)

  const openCreate = () => setEditing({ id: null, name: '', studentIds: new Set() })
  const openEdit = (group) => setEditing({ id: group.id, name: group.name, studentIds: new Set(group.studentIds) })

  const toggle = (studentId) => {
    setEditing((prev) => {
      if (!prev) return prev
      const next = new Set(prev.studentIds)
      if (next.has(studentId)) next.delete(studentId)
      else next.add(studentId)
      return { ...prev, studentIds: next }
    })
  }

  const save = async () => {
    if (!editing || !editing.name.trim()) return toast.error('Name is required')
    setBusy(true)
    try {
      const studentIds = [...editing.studentIds]
      if (editing.id) await updateGroup(editing.id, { name: editing.name, studentIds })
      else await createGroup(classroomId, { name: editing.name, studentIds })
      toast.success('Saved')
      setEditing(null)
      onChange()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (groupId) => {
    try {
      await deleteGroup(groupId)
      onChange()
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="spread" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <strong>Groups</strong>
        <button className="btn btn-outline btn-sm" onClick={openCreate}>＋ New group</button>
      </div>
      {groups.length === 0 ? (
        <div className="small muted" style={{ padding: '12px 18px' }}>No groups yet — create one to target coursework at a subset of the class.</div>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="spread" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{g.name}</div>
              <div className="tiny faint">{g.studentIds.length} student{g.studentIds.length === 1 ? '' : 's'}</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => openEdit(g)}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={() => remove(g.id)}>Delete</button>
            </div>
          </div>
        ))
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit group' : 'New group'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>Save</button>
          </>
        }
      >
        <div className="col" style={{ gap: 12 }}>
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              placeholder="e.g. Reading group A"
              value={editing?.name || ''}
              onChange={(e) => setEditing((prev) => prev && { ...prev, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Members</label>
            <div className="col" style={{ gap: 6, maxHeight: 240, overflowY: 'auto' }}>
              {students.length === 0 ? (
                <span className="small muted">No students enrolled yet.</span>
              ) : students.map((s) => (
                <label key={s.studentId} className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={editing?.studentIds.has(s.studentId) ?? false}
                    onChange={() => toggle(s.studentId)}
                  />
                  <span className="small">{s.studentName || s.studentId}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default function PeopleTab({ classroom, isTeacher, isOwner }) {
  const toast = useToast()
  const [roster, setRoster] = useState(null)
  const [pending, setPending] = useState([])
  const [coTeachers, setCoTeachers] = useState([])
  const [groups, setGroups] = useState([])
  const [coTeacherEmail, setCoTeacherEmail] = useState('')
  const [addingCoTeacher, setAddingCoTeacher] = useState(false)
  const [studentEmail, setStudentEmail] = useState('')
  const [invitingStudent, setInvitingStudent] = useState(false)
  const [lookupStudent, setLookupStudent] = useState(/** @type {{ studentId: string, studentName: string | null } | null} */ (null))
  const [guardiansStudent, setGuardiansStudent] = useState(/** @type {{ studentId: string, studentName: string | null } | null} */ (null))

  const load = async () => {
    if (!isTeacher) {
      setRoster([])
      return
    }
    try {
      const [r, p, ct, g] = await Promise.all([
        listClassroomStudents(classroom.id),
        listPendingEnrollments(classroom.id).catch(() => []),
        listCoTeachers(classroom.id).catch(() => []),
        listGroups(classroom.id).catch(() => []),
      ])
      setRoster(r)
      setPending(p)
      setCoTeachers(ct)
      setGroups(g)
    } catch (e) {
      toast.error(e.message)
      setRoster([])
    }
  }
  useEffect(() => {
    load() // eslint-disable-next-line
  }, [classroom.id])

  const act = async (studentId, action) => {
    try {
      if (action === 'remove') await removeStudent(classroom.id, studentId)
      else if (action === 'approve') await approveEnrollment(classroom.id, studentId)
      else await rejectEnrollment(classroom.id, studentId)
      load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const submitAddCoTeacher = async (e) => {
    e.preventDefault()
    if (!coTeacherEmail.trim()) return
    setAddingCoTeacher(true)
    try {
      await addCoTeacher(classroom.id, coTeacherEmail.trim())
      setCoTeacherEmail('')
      toast.success('Co-teacher added.')
      load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setAddingCoTeacher(false)
    }
  }

  const removeCoTeacherUser = async (userId) => {
    try {
      await removeCoTeacher(classroom.id, userId)
      load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const submitInviteStudent = async (e) => {
    e.preventDefault()
    if (!studentEmail.trim()) return
    setInvitingStudent(true)
    try {
      await inviteStudentByEmail(classroom.id, studentEmail.trim())
      setStudentEmail('')
      toast.success('Student enrolled.')
      load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setInvitingStudent(false)
    }
  }

  if (!isTeacher) {
    return (
      <div className="card card-pad" style={{ maxWidth: 620 }}>
        <div className="row" style={{ gap: 12 }}>
          <Avatar name="Teacher" id={classroom.teacherId} />
          <div>
            <div style={{ fontWeight: 600 }}>Class teacher</div>
            <div className="small muted">You’re an enrolled member of this class.</div>
          </div>
        </div>
      </div>
    )
  }

  if (roster === null) return <Loading />

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="spread" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <strong>Co-teachers</strong>
          <span className="badge">{coTeachers.length}</span>
        </div>
        {coTeachers.length === 0 ? (
          <div className="small muted" style={{ padding: '12px 18px' }}>No co-teachers yet.</div>
        ) : (
          coTeachers.map((t) => (
            <div key={t.userId} className="spread" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 12 }}>
                <Avatar name={t.name} id={t.userId} size="sm" />
                <span>{t.name || t.userId}</span>
              </div>
              {isOwner && (
                <button className="btn btn-danger btn-sm" onClick={() => removeCoTeacherUser(t.userId)}>Remove</button>
              )}
            </div>
          ))
        )}
        {isOwner && (
          <form onSubmit={submitAddCoTeacher} className="row" style={{ gap: 8, padding: '14px 18px' }}>
            <input
              className="input"
              type="email"
              placeholder="teacher@school.com"
              value={coTeacherEmail}
              onChange={(e) => setCoTeacherEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={addingCoTeacher}>
              {addingCoTeacher ? 'Adding…' : 'Add'}
            </button>
          </form>
        )}
      </div>

      {pending.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 18, borderColor: 'color-mix(in srgb, var(--amber-500) 40%, var(--border))' }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>⏳ Pending requests ({pending.length})</div>
          {pending.map((s) => (
            <div key={s.studentId} className="spread" style={{ padding: '8px 0' }}>
              <div className="row" style={{ gap: 10 }}><Avatar name={s.studentName} id={s.studentId} size="sm" /><span className="small">{s.studentName || s.studentId}</span></div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => act(s.studentId, 'approve')}>Approve</button>
                <button className="btn btn-ghost btn-sm" onClick={() => act(s.studentId, 'reject')}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <GroupsPanel classroomId={classroom.id} students={roster} groups={groups} onChange={load} />

      <div className="card">
        <div className="spread" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <strong>Students</strong>
          <span className="badge">{roster.length}</span>
        </div>
        <form onSubmit={submitInviteStudent} className="row" style={{ gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <input
            className="input"
            type="email"
            placeholder="student@school.com"
            value={studentEmail}
            onChange={(e) => setStudentEmail(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={invitingStudent}>
            {invitingStudent ? 'Inviting…' : 'Invite by email'}
          </button>
        </form>
        {roster.length === 0 ? (
          <EmptyState icon="👥" title="No students yet" hint={`Invite by email above, or share the join code “${classroom.joinCode}” with your class.`} />
        ) : (
          roster.map((s) => (
            <div key={s.studentId} className="spread" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <button
                className="row"
                style={{ gap: 12, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
                onClick={() => setLookupStudent(s)}
                title="See this student's other classes"
              >
                <Avatar name={s.studentName} id={s.studentId} size="sm" />
                <span>{s.studentName || s.studentId}</span>
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setLookupStudent(s)}>Other classes</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setGuardiansStudent(s)}>Guardians</button>
                <button className="btn btn-danger btn-sm" onClick={() => act(s.studentId, 'remove')}>Remove</button>
              </div>
            </div>
          ))
        )}
      </div>

      <StudentClassesModal
        student={lookupStudent}
        currentClassroomId={classroom.id}
        onClose={() => setLookupStudent(null)}
      />

      <GuardiansModal
        student={guardiansStudent}
        onClose={() => setGuardiansStudent(null)}
      />
    </div>
  )
}
