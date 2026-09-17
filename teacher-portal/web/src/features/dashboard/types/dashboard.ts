import type { CapabilityId } from '../../shared/services/capability'
import type {
  Confidence,
  Evidence,
  Priority,
  Provenance,
  SuggestedAction,
} from '../../shared/types/common'
import type { CourseworkType } from '../../shared/types/lms'

/* ── A. Today's schedule ──────────────────────────────────────────────────── */

export interface ScheduleEntry {
  readonly classroomId: string
  readonly classroomName: string
  readonly subject: string | null
  readonly section: string | null
  readonly color: string
  readonly studentCount: number
  /** Work from this class falling due today. */
  readonly dueToday: readonly ScheduleDueItem[]
  /** Soonest due item still ahead today; drives the countdown. */
  readonly nextDueAt: string | null
}

export interface ScheduleDueItem {
  readonly courseworkId: string
  readonly title: string
  readonly type: CourseworkType
  readonly dueAt: string
}

export interface TodaySchedule {
  readonly date: string
  readonly entries: readonly ScheduleEntry[]
  readonly totalDueToday: number
  /**
   * Period times, room and join links need a timetable the LMS does not model.
   * Declared rather than invented.
   */
  readonly missingCapabilities: readonly CapabilityId[]
}

/* ── B. Pending reviews ───────────────────────────────────────────────────── */

export type PendingReviewKind =
  | 'assignment-grading'
  | 'quiz-review'
  | 'late-submission'
  | 'student-doubt'
  | 'guardian-message'
  /** Sprint 4, P4 (T4.2) — signals `GET /teacher/todo` surfaces that no
   * screen showed before: grades saved with `returnToStudent: false` and
   * never followed up, students waiting on an enrollment decision, overdue
   * work with nobody's turned it in, coursework scheduled to auto-publish
   * soon, and drafts a teacher started and never came back to. */
  | 'held-grades'
  | 'pending-enrollment'
  | 'missing-work'
  | 'scheduled-soon'
  | 'draft-unpublished'

export interface PendingReview {
  readonly id: string
  readonly kind: PendingReviewKind
  readonly label: string
  readonly detail: string
  readonly count: number
  readonly priority: Priority
  readonly classroomId: string | null
  readonly classroomName: string | null
  readonly courseworkId: string | null
  /** Set when the row exists but its source is not built yet. */
  readonly capability: CapabilityId | null
  readonly action: SuggestedAction | null
}

export interface PendingReviewSummary {
  readonly items: readonly PendingReview[]
  readonly total: number
  /** Rows whose source is scoped to one class rather than the whole workload. */
  readonly scopedNote: string | null
}

/* ── D. Recommendations ───────────────────────────────────────────────────── */

/**
 * A recommendation is an insight promoted to the dashboard: the same evidence
 * and provenance, plus a single action the teacher is being asked to take.
 */
export interface Recommendation {
  readonly id: string
  readonly title: string
  readonly summary: string
  /** Long form, shown when the card is expanded. */
  readonly explanation: string
  readonly method: string
  readonly priority: Priority
  readonly confidence: Confidence
  readonly evidence: readonly Evidence[]
  readonly primaryAction: SuggestedAction | null
  readonly secondaryActions: readonly SuggestedAction[]
  readonly classroomId: string
  readonly classroomName: string
  readonly provenance: Provenance
  /** The insight this was promoted from, for the details route. */
  readonly insightId: string
}

/* ── E. Deadlines ─────────────────────────────────────────────────────────── */

export interface CalendarItem {
  readonly id: string
  readonly title: string
  readonly type: CourseworkType
  readonly dueAt: string
  readonly classroomId: string
  readonly classroomName: string
  readonly maxPoints: number | null
}

export interface DeadlineGroup {
  readonly date: string
  readonly label: string
  readonly items: readonly CalendarItem[]
}

/* ── F. Quick actions ─────────────────────────────────────────────────────── */

export interface QuickAction {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly icon: string
  readonly kind: SuggestedAction['kind']
  readonly capability: CapabilityId | null
}
