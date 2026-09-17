import type { AIInsight } from '../../ai-inbox/types/insight'
import type { CapabilityId } from '../../shared/services/capability'

/**
 * The timeline's event vocabulary.
 *
 * This is the product's full taxonomy, not just what the LMS emits today.
 * `timelineService.ts` documents exactly which LMS record produces which type;
 * the rest have no source yet and simply never appear. Declaring the whole
 * vocabulary up front means adding a source later is a mapping change, not a
 * type change that ripples through every component.
 */
export type TimelineEventType =
  | 'announcement'
  | 'assignment'
  | 'homework'
  | 'material'
  | 'quiz'
  | 'question'
  | 'discussion'
  | 'teacher-feedback'
  | 'ai-insight'
  | 'ai-generated'
  | 'revision-session'
  | 'exam-reminder'
  | 'live-class'
  | 'parent-communication'

export interface TimelineEventTypeSpec {
  readonly id: TimelineEventType
  readonly label: string
  readonly icon: string
  /** Token expression for the icon tile; resolves in both themes. */
  readonly tint: string
  /** LMS record this type is derived from, or the capability it waits on. */
  readonly source: string
}

export const EVENT_TYPES: Readonly<Record<TimelineEventType, TimelineEventTypeSpec>> = {
  announcement: {
    id: 'announcement',
    label: 'Announcement',
    icon: '📣',
    tint: 'var(--primary-soft)',
    source: 'stream.py · Announcement',
  },
  assignment: {
    id: 'assignment',
    label: 'Assignment',
    icon: '📝',
    tint: 'color-mix(in srgb, var(--sky-500) 14%, transparent)',
    source: 'coursework.py · type=assignment',
  },
  homework: {
    id: 'homework',
    label: 'Homework',
    icon: '🏠',
    tint: 'color-mix(in srgb, var(--sky-500) 14%, transparent)',
    source: 'coursework.py · type=assignment with a “homework” topic',
  },
  material: {
    id: 'material',
    label: 'Material',
    icon: '📎',
    tint: 'var(--surface-2)',
    source: 'coursework.py · type=material',
  },
  quiz: {
    id: 'quiz',
    label: 'Quiz published',
    icon: '🧪',
    tint: 'color-mix(in srgb, var(--amber-500) 15%, transparent)',
    source: 'coursework.py · type=quiz',
  },
  question: {
    id: 'question',
    label: 'Question',
    icon: '❓',
    tint: 'color-mix(in srgb, var(--sky-500) 14%, transparent)',
    source: 'coursework.py · type=question',
  },
  discussion: {
    id: 'discussion',
    label: 'Discussion',
    icon: '💬',
    tint: 'var(--surface-2)',
    source: 'discussions.py · student-authored comments',
  },
  'teacher-feedback': {
    id: 'teacher-feedback',
    label: 'Teacher feedback',
    icon: '✍️',
    tint: 'color-mix(in srgb, var(--emerald-500) 13%, transparent)',
    source: 'discussions.py · teacher-authored comments',
  },
  'ai-insight': {
    id: 'ai-insight',
    label: 'AI insight',
    icon: '🧠',
    tint: 'var(--primary-soft)',
    source: 'insightRules.ts · deterministic class-pattern detection',
  },
  'ai-generated': {
    id: 'ai-generated',
    label: 'AI generated',
    icon: '✨',
    tint: 'var(--primary-soft)',
    source: 'awaiting services/ai generation endpoints',
  },
  'revision-session': {
    id: 'revision-session',
    label: 'Revision session',
    icon: '🔁',
    tint: 'color-mix(in srgb, var(--emerald-500) 13%, transparent)',
    source: 'awaiting a scheduled-session model in services/lms',
  },
  'exam-reminder': {
    id: 'exam-reminder',
    label: 'Exam reminder',
    icon: '⏰',
    tint: 'color-mix(in srgb, var(--rose-500) 13%, transparent)',
    source: 'awaiting an exam model in services/lms',
  },
  'live-class': {
    id: 'live-class',
    label: 'Live class',
    icon: '📹',
    tint: 'color-mix(in srgb, var(--sky-500) 14%, transparent)',
    source: 'awaiting lms.timetable',
  },
  'parent-communication': {
    id: 'parent-communication',
    label: 'Parent communication',
    icon: '👪',
    tint: 'var(--surface-2)',
    source: 'awaiting lms.guardian-messages',
  },
}

export interface TimelineAttachmentRef {
  readonly id: string
  readonly title: string
  readonly url: string | null
  readonly kind: 'link' | 'file' | 'coursework'
}

export interface TimelineAuthor {
  readonly id: string
  readonly name: string
  readonly role: 'teacher' | 'student' | 'system'
}

export interface TimelineEvent {
  readonly id: string
  readonly type: TimelineEventType
  /** Sort key: published time where available, else creation. */
  readonly timestamp: string
  readonly title: string
  readonly body: string
  readonly author: TimelineAuthor
  readonly classroomId: string
  readonly classroomName: string
  readonly attachments: readonly TimelineAttachmentRef[]
  readonly commentCount: number
  readonly isPinned: boolean
  readonly canPin: boolean
  readonly canComment: boolean
  readonly dueAt: string | null
  /** Short badges rendered in the card meta line. */
  readonly badges: readonly string[]
  /** Present for `ai-insight` events; drives the inline evidence view. */
  readonly insight: AIInsight | null
  /** Deep-link targets. */
  readonly announcementId: string | null
  readonly courseworkId: string | null
  /** `draft` | `published` | `scheduled` — `null` for event kinds with no
   * publish lifecycle (insights). Announcements and coursework both use this
   * three-state model (`stream.py` / `coursework.py`). */
  readonly publishStatus: 'draft' | 'published' | 'scheduled' | null
  /** Set only when `publishStatus === 'scheduled'` — the post's
   * `Announcement.scheduled_for` (`coursework.py` equivalent not surfaced
   * here yet; `dueAt` already covers coursework's own date badge). */
  readonly scheduledFor: string | null
  /** Teacher-only, and only ever true for a `scheduled` announcement — drives
   * the "Post now" / "Edit" actions on the card. Precomputed here (rather
   * than re-derived in the component) for the same reason `canPin` is:
   * `list_announcements` already withholds `scheduled` rows from students, so
   * this is belt-and-suspenders, not the only gate. */
  readonly canManageSchedule: boolean
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

export type TimelineFilterId =
  | 'all'
  | 'announcements'
  | 'assignments'
  | 'ai'
  | 'discussions'
  | 'exams'
  | 'homework'
  | 'materials'
  | 'pinned'

export interface TimelineFilterSpec {
  readonly id: TimelineFilterId
  readonly label: string
  /** Empty means "everything"; `pinned` is handled separately. */
  readonly types: readonly TimelineEventType[]
}

/**
 * `materials` is an addition to the eight specified chips: material is a
 * first-class LMS coursework type and would otherwise be the only kind of event
 * a teacher could not filter to.
 */
export const TIMELINE_FILTERS: readonly TimelineFilterSpec[] = [
  { id: 'all', label: 'All', types: [] },
  { id: 'announcements', label: 'Announcements', types: ['announcement'] },
  { id: 'assignments', label: 'Assignments', types: ['assignment', 'question'] },
  { id: 'homework', label: 'Homework', types: ['homework'] },
  { id: 'exams', label: 'Exams', types: ['quiz', 'exam-reminder'] },
  { id: 'materials', label: 'Materials', types: ['material'] },
  { id: 'ai', label: 'AI', types: ['ai-insight', 'ai-generated'] },
  { id: 'discussions', label: 'Discussions', types: ['discussion', 'teacher-feedback'] },
  { id: 'pinned', label: 'Pinned', types: [] },
]

/* ── Grouping ─────────────────────────────────────────────────────────────── */

export interface TimelineDayGroup {
  readonly date: string
  readonly label: string
  readonly events: readonly TimelineEvent[]
}

export interface TimelineMonthGroup {
  readonly month: string
  readonly label: string
  readonly days: readonly TimelineDayGroup[]
}

/** Event-level reactions and AI summaries both wait on backends. */
export const TIMELINE_CAPABILITIES: readonly CapabilityId[] = [
  'lms.event-reactions',
  'ai.event-summary',
]
