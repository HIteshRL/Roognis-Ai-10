import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Modal, useToast } from '../../../components/ui'
import { CapabilityNotice } from '../../shared/components/CapabilityNotice'
import { CAPABILITIES, type CapabilityId } from '../../shared/services/capability'
import { useClassrooms } from '../../shared/hooks/useClassrooms'
import {
  type AnnouncementInput,
  type CreateWorkInput,
  type UploadMaterialInput,
  announcementWorkflow,
  createAssignmentWorkflow,
  uploadMaterialWorkflow,
} from '../services/definitions'
import { useWorkflowRunner } from '../hooks/useWorkflowRunner'
import { type QuickActionId, useQuickAction } from '../hooks/useQuickAction'
import { WorkflowRunView } from './WorkflowRunView'

/** Quick actions with no backend at all render a capability notice instead of a form. */
const UNBUILT: Partial<Record<QuickActionId, CapabilityId>> = {
  'take-attendance': 'lms.attendance',
  'generate-lesson': 'ai.lesson-generation',
  'message-guardian': 'lms.guardian-messages',
}

const TITLES: Readonly<Record<QuickActionId, string>> = {
  'create-assignment': 'Create assignment',
  'create-quiz': 'Create quiz',
  'upload-material': 'Upload material',
  'generate-lesson': 'AI lesson generator',
  'take-attendance': 'Take attendance',
  'post-announcement': 'Post announcement',
  'schedule-revision': 'Schedule revision',
  'message-guardian': 'Message guardian',
}

/** `datetime-local` needs `YYYY-MM-DDTHH:mm` in local time, not an ISO string. */
const toLocalInput = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function QuickActionModal(): JSX.Element | null {
  const { action, params, close } = useQuickAction()
  const toast = useToast()
  const classrooms = useClassrooms()

  const [classroomId, setClassroomId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [maxPoints, setMaxPoints] = useState('100')
  const [url, setUrl] = useState('')
  const [announce, setAnnounce] = useState(true)

  // Seed from the URL, then from the first class, whenever the action changes.
  useEffect(() => {
    if (!action) return
    setClassroomId(params.classroomId ?? classrooms.data?.[0]?.id ?? '')
    setTitle(params.title ?? (action === 'schedule-revision' && params.topic ? `Revision: ${params.topic}` : ''))
    setDescription(
      params.studentName ? `Follow-up for ${params.studentName}.` : '',
    )
    setDueAt(
      action === 'schedule-revision'
        ? toLocalInput(new Date(Date.now() + 2 * 86_400_000))
        : '',
    )
    setMaxPoints('100')
    setUrl('')
    setAnnounce(true)
    // Only re-seed on a new action or once classes arrive.
  }, [action, params.classroomId, params.title, params.topic, params.studentName, classrooms.data])

  const classroom = useMemo(
    () => classrooms.data?.find((entry) => entry.id === classroomId) ?? null,
    [classrooms.data, classroomId],
  )

  const runner = useWorkflowRunner()

  if (!action) return null

  const unbuilt = UNBUILT[action]
  const isWork = action === 'create-assignment' || action === 'create-quiz' || action === 'schedule-revision'
  const isMaterial = action === 'upload-material'
  const isAnnouncement = action === 'post-announcement'

  const canSubmit =
    Boolean(classroomId) &&
    (isAnnouncement ? description.trim().length > 0 : title.trim().length > 0) &&
    !runner.running

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmit || !classroom) return

    const shared = { classroomId, classroomName: classroom.name }

    // Each branch pairs a definition with the input type it declares, so the
    // engine's generic call checks them against each other.
    const result = isMaterial
      ? await runner.start(uploadMaterialWorkflow, {
          ...shared,
          title: title.trim(),
          description: description.trim(),
          url: url.trim(),
        } satisfies UploadMaterialInput)
      : isAnnouncement
        ? await runner.start(announcementWorkflow, {
            ...shared,
            title: title.trim(),
            body: description.trim(),
            pin: false,
          } satisfies AnnouncementInput)
        : await runner.start(createAssignmentWorkflow(action === 'create-quiz' ? 'quiz' : 'assignment'), {
            ...shared,
            title: title.trim(),
            description: description.trim(),
            dueAt: dueAt ? new Date(dueAt).toISOString() : null,
            maxPoints: Number.parseInt(maxPoints, 10) || null,
            announceToClass: announce,
          } satisfies CreateWorkInput)

    if (result.status === 'failed') toast.error('That did not complete — see the steps for detail.')
    else toast.success(`${TITLES[action]} finished.`)
  }

  const done = runner.run !== null && runner.run.status !== 'idle'

  return (
    <Modal
      open
      onClose={close}
      title={TITLES[action]}
      wide={done}
      footer={
        unbuilt ? (
          <button className="btn btn-outline" onClick={close}>
            Close
          </button>
        ) : done && !runner.running ? (
          <>
            <button className="btn btn-ghost" onClick={runner.reset}>
              Run another
            </button>
            <button className="btn btn-primary" onClick={close}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={close} disabled={runner.running}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={(event) => void onSubmit(event)}
              disabled={!canSubmit}
            >
              {runner.running ? 'Running…' : TITLES[action]}
            </button>
          </>
        )
      }
    >
      {unbuilt ? (
        <CapabilityNotice capability={CAPABILITIES[unbuilt]} />
      ) : done ? (
        <div className="col" style={{ gap: 14 }}>
          {runner.summary && <div className="small">{runner.summary}</div>}
          {runner.run && <WorkflowRunView run={runner.run} />}
        </div>
      ) : (
        <form className="col" style={{ gap: 14 }} onSubmit={(event) => void onSubmit(event)}>
          <div className="field">
            <label htmlFor="qa-class">Class</label>
            <select
              id="qa-class"
              className="select"
              value={classroomId}
              onChange={(event) => setClassroomId(event.target.value)}
              required
            >
              <option value="" disabled>
                {classrooms.status === 'loading' ? 'Loading classes…' : 'Select a class'}
              </option>
              {(classrooms.data ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.section ? ` · ${entry.section}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="qa-title">{isAnnouncement ? 'Title (optional)' : 'Title'}</label>
            <input
              id="qa-title"
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={isMaterial ? 'Chapter 5 — Photosynthesis notes' : 'Fractions practice set 2'}
              required={!isAnnouncement}
            />
          </div>

          <div className="field">
            <label htmlFor="qa-desc">{isAnnouncement ? 'Message' : 'Instructions'}</label>
            <textarea
              id="qa-desc"
              className="textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={
                isAnnouncement ? 'What should the class know?' : 'What should students do?'
              }
              required={isAnnouncement}
            />
          </div>

          {isMaterial && (
            <div className="field">
              <label htmlFor="qa-url">Link to the material</label>
              <input
                id="qa-url"
                className="input"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
              <span className="tiny faint">
                The LMS stores links; file upload needs an object-store endpoint that does not exist yet.
              </span>
            </div>
          )}

          {isWork && (
            <>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="field grow">
                  <label htmlFor="qa-due">Due</label>
                  <input
                    id="qa-due"
                    className="input"
                    type="datetime-local"
                    value={dueAt}
                    onChange={(event) => setDueAt(event.target.value)}
                  />
                  <span className="tiny faint">A due date is what puts this on the calendar.</span>
                </div>
                <div className="field" style={{ width: 120 }}>
                  <label htmlFor="qa-points">Points</label>
                  <input
                    id="qa-points"
                    className="input"
                    type="number"
                    min={0}
                    value={maxPoints}
                    onChange={(event) => setMaxPoints(event.target.value)}
                  />
                </div>
              </div>

              <label className="row" style={{ gap: 9, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={announce}
                  onChange={(event) => setAnnounce(event.target.checked)}
                />
                <span className="small">
                  Announce to the class
                  <span className="faint"> — publishing alone does not notify students.</span>
                </span>
              </label>
            </>
          )}
        </form>
      )}
    </Modal>
  )
}
