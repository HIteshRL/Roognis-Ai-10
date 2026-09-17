import { useState } from 'react'
import { Avatar, useToast } from '../../../components/ui'
import { useAuth } from '../../../auth/AuthContext'
import { useMutation } from '../../shared/hooks/useMutation'
import { createAnnouncement, type CreateAnnouncementInput } from '../../shared/services/lmsService'
import type { Announcement, Classroom } from '../../shared/types/lms'
import type { SuggestedAction } from '../../shared/types/common'
import { AnnouncementScheduleControl, type AnnouncementScheduleMode } from './AnnouncementScheduleControl'

type ComposerMode = 'announcement' | 'assignment' | 'quiz' | 'material'

const MODES: readonly { id: ComposerMode; label: string; icon: string }[] = [
  { id: 'announcement', label: 'Announce', icon: '📣' },
  { id: 'assignment', label: 'Assignment', icon: '📝' },
  { id: 'quiz', label: 'Quiz', icon: '🧪' },
  { id: 'material', label: 'Material', icon: '📎' },
]

const ACTION_KIND: Readonly<Record<Exclude<ComposerMode, 'announcement'>, SuggestedAction['kind']>> = {
  assignment: 'create-assignment',
  quiz: 'create-quiz',
  material: 'upload-material',
}

/**
 * Composer at the head of the timeline.
 *
 * Announcements post inline, because that is a one-field action and a modal for
 * it would be friction. Everything else runs a multi-step workflow (create →
 * publish → calendar → notify), so it hands off to the quick-action modal where
 * that run can be shown.
 *
 * Scheduling stays inline for the same reason: `stream.py`'s
 * `CreateAnnouncementRequest` takes `status: 'scheduled'` + `scheduledFor` in
 * the same single POST as an immediate post, so there is no second step to
 * push into a modal.
 */
export function TimelineComposer({
  classroom,
  onAction,
}: {
  classroom: Classroom
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  const { user } = useAuth()
  const toast = useToast()
  const [mode, setMode] = useState<ComposerMode>('announcement')
  const [body, setBody] = useState('')
  const [scheduleMode, setScheduleMode] = useState<AnnouncementScheduleMode>('now')
  const [scheduledFor, setScheduledFor] = useState('')

  const post = useMutation<CreateAnnouncementInput, Announcement>(
    (input) => createAnnouncement(classroom.id, input),
    {
      invalidates: [['lms', 'announcements', classroom.id]],
      onSuccess: (_result, input) => {
        setBody('')
        setScheduleMode('now')
        setScheduledFor('')
        toast.success(
          input.status === 'scheduled'
            ? `Scheduled for ${new Date(input.scheduledFor as string).toLocaleString()}.`
            : 'Posted — every enrolled student was notified.',
        )
      },
      onError: (error) => toast.error(error.message),
    },
  )

  const canSchedule = scheduleMode === 'now' || scheduledFor.trim().length > 0
  const canSubmit = body.trim().length > 0 && canSchedule && !post.pending

  const submit = () => {
    if (!canSubmit) return
    const input: CreateAnnouncementInput =
      scheduleMode === 'later'
        ? { body: body.trim(), status: 'scheduled', scheduledFor: new Date(scheduledFor).toISOString() }
        : { body: body.trim() }
    void post.mutate(input)
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div className="tl-composer-tabs" role="tablist" aria-label="What to post">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            className="chip"
            role="tab"
            aria-selected={mode === entry.id}
            aria-pressed={mode === entry.id}
            onClick={() => {
              setMode(entry.id)
              if (entry.id !== 'announcement') {
                onAction({
                  id: `composer:${entry.id}`,
                  label: entry.label,
                  kind: ACTION_KIND[entry.id],
                  intent: 'primary',
                  params: { classroomId: classroom.id },
                })
              }
            }}
          >
            <span aria-hidden="true">{entry.icon}</span>
            {entry.label}
          </button>
        ))}
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={user?.name} id={user?.userId} />
        <div className="grow">
          <label htmlFor="composer-body" style={{ position: 'absolute', left: -9999 }}>
            Announcement text
          </label>
          <textarea
            id="composer-body"
            className="textarea"
            placeholder={`Share something with ${classroom.name}…`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />

          <div style={{ marginTop: 10 }}>
            <AnnouncementScheduleControl
              idPrefix="composer"
              mode={scheduleMode}
              onModeChange={setScheduleMode}
              scheduledFor={scheduledFor}
              onScheduledForChange={setScheduledFor}
              disabled={post.pending}
            />
          </div>

          <div className="spread" style={{ marginTop: 10 }}>
            <span className="tiny faint">
              {scheduleMode === 'later'
                ? 'Students are notified when the post goes live, not when it’s scheduled.'
                : 'Posting notifies every enrolled student. Publishing coursework, on its own, does not.'}
            </span>
            <button className="btn btn-primary btn-sm" disabled={!canSubmit} onClick={submit}>
              {post.pending ? 'Posting…' : scheduleMode === 'later' ? 'Schedule' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
