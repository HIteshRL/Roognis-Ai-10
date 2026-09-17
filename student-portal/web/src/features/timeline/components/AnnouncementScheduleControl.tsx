/**
 * "Post now" / "Schedule for later" — the same choice `ClassworkTab.jsx`'s
 * `PublishDialog` offers for coursework (radio buttons, matching label/gap
 * style), paired with the datetime-local field `ClassworkFormModal` uses for
 * `scheduledFor`. Extracted because the composer (create) and the edit
 * dialog (`EditAnnouncementDialog.tsx`) need the exact same control — this is
 * small and stateless enough that duplicating it would only invite the two
 * copies to drift.
 *
 * Purely controlled: the caller owns `mode`/`scheduledFor` and decides what
 * to send (`stream.py`'s `CreateAnnouncementRequest`/`UpdateAnnouncementRequest`
 * both take `status: 'scheduled'` + `scheduledFor` as an ISO datetime).
 */
export type AnnouncementScheduleMode = 'now' | 'later'

export function AnnouncementScheduleControl({
  idPrefix,
  mode,
  onModeChange,
  scheduledFor,
  onScheduledForChange,
  disabled = false,
}: {
  /** Unique per instance so two composers/dialogs on one page don't share a
   * radio group by name collision. */
  idPrefix: string
  mode: AnnouncementScheduleMode
  onModeChange: (mode: AnnouncementScheduleMode) => void
  /** `datetime-local` input value (no timezone) — the caller converts to ISO
   * with `new Date(value).toISOString()` right before sending. */
  scheduledFor: string
  onScheduledForChange: (value: string) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="radio"
            name={`${idPrefix}-schedule-mode`}
            checked={mode === 'now'}
            disabled={disabled}
            onChange={() => onModeChange('now')}
          />
          <span className="small">Post now</span>
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="radio"
            name={`${idPrefix}-schedule-mode`}
            checked={mode === 'later'}
            disabled={disabled}
            onChange={() => onModeChange('later')}
          />
          <span className="small">Schedule for later</span>
        </label>
      </div>
      {mode === 'later' && (
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor={`${idPrefix}-scheduled-for`} className="tiny faint">
            Scheduled for
          </label>
          <input
            id={`${idPrefix}-scheduled-for`}
            className="input"
            type="datetime-local"
            value={scheduledFor}
            disabled={disabled}
            onChange={(event) => onScheduledForChange(event.target.value)}
          />
        </div>
      )}
    </div>
  )
}
