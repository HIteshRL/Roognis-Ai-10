import { useEffect, useState } from 'react'
import { Modal } from '../../../components/ui'
import type { TimelineEvent } from '../types/timeline'

/** `datetime-local` has no timezone; both directions go through the local
 * wall-clock, same as `ClassworkFormModal`'s `dueAt`/`scheduledFor` fields. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface EditAnnouncementInput {
  readonly body: string
  readonly scheduledFor: string
}

/**
 * Edits a `scheduled` announcement's text or moves its send time —
 * `PATCH /lms/announcements/{id}` (`stream.py::update_announcement`).
 *
 * Deliberately narrower than `ClassworkFormModal`: this only ever opens on an
 * already-`scheduled` post (`TimelineCard`'s "Edit" only renders then), so
 * there is no "post now" toggle here — the PATCH route only ever updates
 * fields, it never flips `status`. "Post now" is the separate one-click
 * `publishAnnouncement` action next to this button on the card, calling the
 * dedicated `/publish` route instead.
 */
export function EditAnnouncementDialog({
  open,
  busy,
  onClose,
  onSave,
}: {
  open: TimelineEvent | null
  busy: boolean
  onClose: () => void
  onSave: (input: EditAnnouncementInput) => void
}): JSX.Element {
  const [body, setBody] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')

  useEffect(() => {
    if (open) {
      setBody(open.body)
      setScheduledFor(open.scheduledFor ? toLocalInputValue(open.scheduledFor) : '')
    }
  }, [open])

  const canSubmit = body.trim().length > 0 && scheduledFor.trim().length > 0

  const submit = () => {
    if (!canSubmit) return
    onSave({ body: body.trim(), scheduledFor: new Date(scheduledFor).toISOString() })
  }

  return (
    <Modal
      open={open != null}
      onClose={onClose}
      title="Edit scheduled announcement"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !canSubmit}>
            Save changes
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="field">
          <label htmlFor="edit-announcement-body">Text</label>
          <textarea
            id="edit-announcement-body"
            className="textarea"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="edit-announcement-scheduled-for">Scheduled for</label>
          <input
            id="edit-announcement-scheduled-for"
            className="input"
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}
