import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Loading, useToast } from '../components/ui.jsx'
import { getClassroom, listStudentClassrooms } from '../features/shared/services/lmsService'
import { colorFor } from '../lib/format'
import ClassworkTab from './tabs/ClassworkTab.jsx'
import PeopleTab from './tabs/PeopleTab.jsx'
import GradesTab from './tabs/GradesTab.jsx'
import ClassroomSettingsModal from './ClassroomSettingsModal.jsx'

export default function Classroom() {
  const { id } = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const isTeacher = user.role === 'teacher'
  const [cls, setCls] = useState(null)
  const [tab, setTab] = useState('classwork')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        if (isTeacher) {
          setCls(await getClassroom(id))
        } else {
          const classrooms = await listStudentClassrooms()
          setCls(classrooms.find((c) => c.id === id) || { id, name: 'Class', subject: '' })
        }
      } catch (e) {
        toast.error(e.message)
      }
    })() // eslint-disable-next-line
  }, [id])

  if (!cls) return <Loading />

  const isOwner = isTeacher && cls.teacherId === user.userId
  const color = cls.color || colorFor(cls.id)
  // The stream is now the full Timeline route — announcements, coursework and
  // AI insights merged — so this tab navigates rather than rendering in place.
  const tabs = [
    { key: 'timeline', label: 'Timeline', icon: '📣', to: `/classes/${id}/timeline` },
    { key: 'classwork', label: 'Classwork', icon: '📚' },
    { key: 'people', label: 'People', icon: '👥' },
    ...(isTeacher ? [{ key: 'grades', label: 'Grades', icon: '📊' }] : []),
  ]

  return (
    <div>
      <Link to="/classes" className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }}>← All classes</Link>

      <div className="card classroom-header-card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div className="classroom-header-band" style={{ '--class-accent': color }}>
          <div className="spread" style={{ alignItems: 'flex-end' }}>
            <div>
              <h1 style={{ fontSize: 28 }}>{cls.name}</h1>
              <div style={{ opacity: 0.92, marginTop: 4 }}>{cls.subject}{cls.section ? ` · ${cls.section}` : ''}{cls.grade ? ` · ${cls.grade}` : ''}</div>
            </div>
            {isTeacher && cls.joinCode && (
              <div style={{ textAlign: 'right' }}>
                <div className="tiny" style={{ opacity: 0.8 }}>Class code</div>
                <code style={{ fontSize: 20, fontWeight: 800, letterSpacing: '0.08em' }}>{cls.joinCode}</code>
              </div>
            )}
          </div>
        </div>
        <div className="spread" style={{ padding: '0 16px' }}>
          <div className="tabs">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => (t.to ? nav(t.to) : setTab(t.key))}
              >
                <span style={{ marginRight: 6 }}>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
          {isOwner && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(true)}>
              ⚙️ Settings
            </button>
          )}
        </div>
      </div>

      {tab === 'classwork' && <ClassworkTab classroom={cls} isTeacher={isTeacher} />}
      {tab === 'people' && <PeopleTab classroom={cls} isTeacher={isTeacher} isOwner={isOwner} />}
      {tab === 'grades' && isTeacher && <GradesTab classroom={cls} />}

      {isOwner && (
        <ClassroomSettingsModal
          classroom={cls}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={setCls}
        />
      )}
    </div>
  )
}
