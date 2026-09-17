import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../auth/AuthContext'
import { Badge, EmptyState, Icon, Loading, Modal, useToast } from '../../../components/ui'
import { fmtDate, fmtDateTime } from '../../../lib/format'
import { CalendarMini } from '../../dashboard/components/CalendarMini'
import { DashboardCard } from '../../shared/components/DashboardCard'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { CAPABILITIES } from '../../shared/services/capability'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listTeacherClassrooms,
  updateCalendarEvent,
} from '../../shared/services/lmsService'
import type { CalendarScheduledEvent, Classroom, CourseworkType } from '../../shared/types/lms'
import { useCalendarRange } from '../hooks/useCalendarRange'

const ICON: Readonly<Record<CourseworkType, string>> = {
  assignment: 'book',
  quiz: 'check',
  question: 'insights',
  material: 'library',
}

/** `datetime-local` inputs read/write local wall-clock time with no
 * timezone; the stored value is a UTC ISO string. Converting back for the
 * edit form is the one piece create didn't need (it always starts blank). */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Calendar.
 *
 * Merges two sources (`calendar_view.py`): published coursework due dates,
 * and (Sprint 2, P4) one-off `CalendarEvent` rows a teacher creates
 * directly (exams, field trips) — the latter exist independently of any
 * coursework's `due_at`. Still not a recurring bell-schedule/timetable —
 * see `CAPABILITIES['lms.timetable']`, a separate, still-missing capability.
 */
export default function CalendarPage(): JSX.Element {
  const { user } = useAuth()
  const toast = useToast()
  const isTeacher = user?.role === 'teacher'
  const calendar = useCalendarRange()
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  // null = creating a new event; otherwise the event being edited. The
  // create-then-edit flow reuses one modal rather than a second component —
  // the form shape is identical, only the submit target and the presence of
  // a delete action differ.
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [classrooms, setClassrooms] = useState<readonly Classroom[]>([])
  const [form, setForm] = useState<{
    classroomId?: string
    title?: string
    startsAt?: string
    endsAt?: string
    description?: string
  }>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTeacher) return
    listTeacherClassrooms()
      .then((list) => {
        setClassrooms(list)
        setForm((f) => (f.classroomId ? f : { ...f, classroomId: list[0]?.id }))
      })
      .catch(() => setClassrooms([]))
  }, [isTeacher])

  const days = useMemo(() => {
    const all = calendar.query.data?.days ?? []
    return selectedDate ? all.filter((day) => day.date === selectedDate) : all
  }, [calendar.query.data, selectedDate])

  const total = calendar.query.data?.total ?? 0

  const closeModal = () => {
    setShowModal(false)
    setEditingEventId(null)
  }

  const openCreateModal = () => {
    setEditingEventId(null)
    setForm({ classroomId: form.classroomId })
    setShowModal(true)
  }

  const openEditModal = (event: CalendarScheduledEvent) => {
    setEditingEventId(event.eventId)
    setForm({
      classroomId: event.classroomId,
      title: event.title,
      description: event.description ?? '',
      startsAt: toDatetimeLocalValue(event.dueAt),
      endsAt: event.endsAt ? toDatetimeLocalValue(event.endsAt) : '',
    })
    setShowModal(true)
  }

  const submitEvent = async () => {
    if (!form.title?.trim() || !form.startsAt) {
      toast.error('Title and start time are required')
      return
    }
    setBusy(true)
    try {
      if (editingEventId) {
        await updateCalendarEvent(editingEventId, {
          title: form.title.trim(),
          description: form.description || null,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        })
        toast.success('Event updated')
      } else {
        if (!form.classroomId) {
          toast.error('Class, title and start time are required')
          return
        }
        await createCalendarEvent(form.classroomId, {
          title: form.title.trim(),
          description: form.description || null,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        })
        toast.success('Event added')
      }
      closeModal()
      setForm({ classroomId: form.classroomId })
      void calendar.query.refetch()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeEvent = async () => {
    if (!editingEventId) return
    if (!window.confirm('Delete this event? This cannot be undone.')) return
    setBusy(true)
    try {
      await deleteCalendarEvent(editingEventId)
      toast.success('Event deleted')
      closeModal()
      void calendar.query.refetch()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Calendar</h1>
          <div className="page-sub">
            Due dates from published coursework, plus exams and events your teacher schedules directly.
          </div>
        </div>

        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={calendar.previous} aria-label="Previous month">
            ‹
          </button>
          <strong style={{ minWidth: 150, textAlign: 'center' }}>{calendar.range.label}</strong>
          <button className="btn btn-ghost btn-sm" onClick={calendar.next} aria-label="Next month">
            ›
          </button>
          {!calendar.isCurrentMonth && (
            <button className="btn btn-outline btn-sm" onClick={calendar.today}>
              Today
            </button>
          )}
          {isTeacher && (
            <button className="btn btn-primary btn-sm" onClick={openCreateModal}>
              ＋ New event
            </button>
          )}
        </div>
      </header>

      <div className="cc-grid">
        <div className="cc-span-4">
          <DashboardCard
            title={calendar.range.label}
            icon="calendar"
            subtitle={`${total} item${total === 1 ? '' : 's'} this month`}
            status={calendar.query.status}
            error={calendar.query.error}
            refreshing={calendar.query.refreshing}
            onRetry={() => void calendar.query.refetch()}
            footer={<CapabilityNotice capability={CAPABILITIES['lms.timetable']} compact />}
          >
            <CalendarMini
              calendar={calendar.query.data}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              monthOffset={calendar.offset}
              onMonthChange={calendar.goToOffset}
            />
          </DashboardCard>
        </div>

        <div className="cc-span-8">
          <DashboardCard
            title={selectedDate ? fmtDate(selectedDate, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Everything scheduled'}
            icon="calendar"
            subtitle={selectedDate ? 'Selected day' : calendar.range.label}
            status={calendar.query.status}
            error={calendar.query.error}
            refreshing={calendar.query.refreshing}
            onRetry={() => void calendar.query.refetch()}
            isEmpty={days.length === 0}
            emptyIcon="calendar"
            emptyTitle={selectedDate ? 'Nothing scheduled that day' : 'Nothing scheduled this month'}
            emptyHint="Due dates from published coursework, and any events your teacher adds, appear here automatically."
            action={
              selectedDate ? (
                <button className="btn btn-ghost btn-sm" onClick={() => setSelectedDate(null)}>
                  Show whole month
                </button>
              ) : null
            }
          >
            {calendar.query.status === 'loading' ? (
              <Loading />
            ) : (
              <div className="col" style={{ gap: 18 }}>
                {days.map((day) => (
                  <div key={day.date}>
                    <div className="row" style={{ gap: 9, marginBottom: 8 }}>
                      <strong style={{ fontSize: 14 }}>
                        {fmtDate(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}
                      </strong>
                      <Badge>{day.events.length}</Badge>
                    </div>

                    <div className="col" style={{ gap: 4 }}>
                      {day.events.map((event) =>
                        event.kind === 'event' ? (
                          isTeacher ? (
                            <button
                              key={event.eventId}
                              type="button"
                              className="cc-row"
                              onClick={() => openEditModal(event)}
                            >
                              <span aria-hidden="true" style={{ fontSize: 17 }}>
                                <Icon name="calendar" size={17} />
                              </span>
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="cc-row-title">{event.title}</div>
                                <div className="cc-row-meta">{event.classroomName ?? 'Class'}</div>
                              </div>
                              <Badge tone="default">{fmtDateTime(event.dueAt)}</Badge>
                            </button>
                          ) : (
                            <div key={event.eventId} className="cc-row">
                              <span aria-hidden="true" style={{ fontSize: 17 }}>
                                <Icon name="calendar" size={17} />
                              </span>
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="cc-row-title">{event.title}</div>
                                <div className="cc-row-meta">{event.classroomName ?? 'Class'}</div>
                              </div>
                              <Badge tone="default">{fmtDateTime(event.dueAt)}</Badge>
                            </div>
                          )
                        ) : (
                          <Link
                            key={event.courseworkId}
                            className="cc-row"
                            to={`/classes/${event.classroomId}/work/${event.courseworkId}`}
                          >
                            <span aria-hidden="true" style={{ fontSize: 17 }}>
                              <Icon name={ICON[event.type] ?? 'book'} size={17} />
                            </span>
                            <div className="grow" style={{ minWidth: 0 }}>
                              <div className="cc-row-title">{event.title}</div>
                              <div className="cc-row-meta">
                                {event.classroomName ?? 'Class'}
                                {event.maxPoints !== null ? ` · ${event.maxPoints} points` : ''}
                              </div>
                            </div>
                            <Badge tone="primary">{fmtDateTime(event.dueAt)}</Badge>
                          </Link>
                        ),
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DashboardCard>
        </div>
      </div>

      {calendar.query.status === 'success' && total === 0 && !selectedDate && (
        <div style={{ marginTop: 18 }}>
          <EmptyState
            icon="calendar"
            title="Nothing scheduled this month"
            hint="Create an assignment with a due date and it will appear here."
            action={
              <Link className="btn btn-primary btn-sm" to="/dashboard?action=create-assignment">
                Create assignment
              </Link>
            }
          />
        </div>
      )}

      {isTeacher && (
        <Modal
          open={showModal}
          onClose={closeModal}
          title={editingEventId ? 'Edit calendar event' : 'New calendar event'}
          footer={
            <>
              {editingEventId && (
                <button className="btn btn-outline" style={{ marginRight: 'auto' }} onClick={removeEvent} disabled={busy}>
                  Delete
                </button>
              )}
              <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={submitEvent} disabled={busy}>
                {editingEventId ? 'Save changes' : 'Create'}
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 14 }}>
            {/* The class isn't editable after creation (UpdateCalendarEventRequest
                has no classroom field) — shown read-only rather than hidden, so
                it's clear which class the event belongs to while editing. */}
            {editingEventId ? (
              <div className="field">
                <label htmlFor="calendar-class">Class</label>
                <input
                  id="calendar-class"
                  className="input"
                  disabled
                  value={classrooms.find((c) => c.id === form.classroomId)?.name ?? 'Class'}
                />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="calendar-class">Class *</label>
                <select
                  id="calendar-class"
                  className="select"
                  value={form.classroomId ?? ''}
                  onChange={(e) => setForm({ ...form, classroomId: e.target.value })}
                >
                  {classrooms.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="calendar-title">Title *</label>
              <input
                id="calendar-title"
                className="input"
                placeholder="Midterm exam"
                value={form.title ?? ''}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <div className="field grow">
                <label htmlFor="calendar-starts">Starts *</label>
                <input
                  id="calendar-starts"
                  className="input"
                  type="datetime-local"
                  value={form.startsAt ?? ''}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </div>
              <div className="field grow">
                <label htmlFor="calendar-ends">Ends</label>
                <input
                  id="calendar-ends"
                  className="input"
                  type="datetime-local"
                  value={form.endsAt ?? ''}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="calendar-description">Description</label>
              <textarea
                id="calendar-description"
                className="textarea"
                placeholder="What students should know…"
                value={form.description ?? ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
