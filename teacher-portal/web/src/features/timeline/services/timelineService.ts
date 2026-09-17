/**
 * Timeline construction.
 *
 * Google Classroom keeps announcements and classwork in two separate places, so
 * a teacher who wants to know "what happened in this class" reads two lists and
 * merges them in their head. Roognis merges them here instead, and adds a third
 * source the LMS has no concept of: the deterministic insights from
 * `insightRules.ts`, which land in the stream at the moment they were detected.
 *
 * Mapping from LMS record to event type — the whole of it, in one place:
 *
 *   Announcement                      → `announcement`
 *   Coursework type=assignment        → `assignment`, or `homework` when the
 *                                       teacher's own `topic` says homework
 *   Coursework type=quiz              → `quiz`
 *   Coursework type=material          → `material`
 *   Coursework type=question          → `question`
 *   AIInsight (client ruleset)        → `ai-insight`
 *
 * The remaining event types in the vocabulary have no source yet and simply do
 * not appear. Nothing is invented to fill them.
 *
 * All selectors here are pure so filtering, searching and grouping can be
 * recomputed on every keystroke without a request.
 */

import { parseApiDate } from '../../../lib/format'
import type { AIInsight } from '../../ai-inbox/types/insight'
import type {
  Announcement,
  Classroom,
  Coursework,
  CourseworkType,
} from '../../shared/types/lms'
import {
  type TimelineAttachmentRef,
  type TimelineDayGroup,
  type TimelineEvent,
  type TimelineEventType,
  type TimelineFilterId,
  type TimelineMonthGroup,
  TIMELINE_FILTERS,
} from '../types/timeline'

/** Announcements the LMS will return in one page (`stream.py` caps at 100). */
export const ANNOUNCEMENT_PAGE_LIMIT = 100

const HOMEWORK_PATTERN = /\bhome\s?work\b/i

const COURSEWORK_TYPE_MAP: Readonly<Record<CourseworkType, TimelineEventType>> = {
  assignment: 'assignment',
  quiz: 'quiz',
  material: 'material',
  question: 'question',
}

/**
 * Homework is not an LMS type. The only teacher-controlled signal that
 * distinguishes it is the `topic` field, so that is what is read — an explicit,
 * deterministic rule rather than a guess about title wording.
 */
function classifyCoursework(work: Coursework): TimelineEventType {
  const base = COURSEWORK_TYPE_MAP[work.type] ?? 'assignment'
  if (base === 'assignment' && work.topic && HOMEWORK_PATTERN.test(work.topic)) return 'homework'
  return base
}

const timeOf = (iso: string | null | undefined): number => parseApiDate(iso)?.getTime() ?? 0

function announcementAttachments(announcement: Announcement): TimelineAttachmentRef[] {
  return (announcement.attachments ?? []).map((attachment, index) => ({
    id: `${announcement.id}:att:${index}`,
    title: attachment.title ?? attachment.url ?? 'Attachment',
    url: attachment.url ?? null,
    kind: 'link',
  }))
}

function courseworkAttachments(work: Coursework): TimelineAttachmentRef[] {
  // Sprint 1, T2.3: Coursework.attachments is now the same list shape as
  // Announcement.attachments — no more links/files-dict adapter needed.
  return (work.attachments ?? []).map((attachment, index) => ({
    id: `${work.id}:att:${index}`,
    title: attachment.title ?? attachment.url ?? 'Attachment',
    url: attachment.url ?? null,
    kind: attachment.type === 'file' ? 'file' : 'link',
  }))
}

const dueBadge = (dueAt: string | null): string[] => {
  if (!dueAt) return []
  const remaining = timeOf(dueAt) - Date.now()
  if (remaining < 0) return ['closed']
  const days = Math.ceil(remaining / 86_400_000)
  return [days <= 1 ? 'due today' : `due in ${days}d`]
}

/* ── Construction ─────────────────────────────────────────────────────────── */

export function buildTimeline(args: {
  readonly classroom: Classroom
  readonly announcements: readonly Announcement[]
  readonly coursework: readonly Coursework[]
  readonly insights: readonly AIInsight[]
  readonly isTeacher: boolean
}): readonly TimelineEvent[] {
  const { classroom, announcements, coursework, insights, isTeacher } = args

  const announcementEvents: TimelineEvent[] = announcements.map((announcement) => ({
    id: `announcement:${announcement.id}`,
    type: 'announcement',
    timestamp: announcement.publishedAt ?? announcement.createdAt ?? new Date().toISOString(),
    title: announcement.title ?? 'Announcement',
    body: announcement.body,
    author: {
      id: announcement.authorId,
      name: announcement.authorName,
      role: announcement.authorId === classroom.teacherId ? 'teacher' : 'student',
    },
    classroomId: classroom.id,
    classroomName: classroom.name,
    attachments: announcementAttachments(announcement),
    commentCount: announcement.commentCount,
    isPinned: announcement.isPinned,
    canPin: isTeacher,
    canComment: true,
    dueAt: null,
    // `scheduled` gets its own richer badge (with the actual time) in
    // TimelineCard, so it's excluded here to avoid showing both.
    badges: announcement.status !== 'published' && announcement.status !== 'scheduled'
      ? [announcement.status]
      : [],
    insight: null,
    announcementId: announcement.id,
    courseworkId: null,
    publishStatus: announcement.status,
    scheduledFor: announcement.scheduledFor,
    canManageSchedule: isTeacher && announcement.status === 'scheduled',
  }))

  // Students only ever see published work; teachers see drafts too, badged.
  const visibleCoursework = coursework.filter(
    (work) => isTeacher || work.status === 'published',
  )

  const courseworkEvents: TimelineEvent[] = visibleCoursework.map((work) => {
    const type = classifyCoursework(work)
    const stats = work.submissionStats
    // `turnedIn` is the not-yet-returned bucket and `graded` the returned
    // one, so submitted is their sum. `assignedCount` is roster-derived
    // (Sprint 1, T3.2 / C2) — the Math.max fallback stays as a defensive
    // guard, not a workaround, now that the backend value is already correct.
    const submitted = stats ? stats.turnedIn + stats.graded : 0
    const assigned = Math.max(stats?.assignedCount ?? 0, classroom.studentCount ?? 0)
    const badges = [
      ...(work.status !== 'published' ? [work.status] : []),
      ...dueBadge(work.dueAt),
      ...(stats && isTeacher && assigned > 0 ? [`${submitted}/${assigned} in`] : []),
    ]

    return {
      id: `coursework:${work.id}`,
      type,
      timestamp: work.publishedAt ?? work.createdAt ?? new Date().toISOString(),
      title: work.title,
      body: work.description ?? '',
      author: {
        id: work.teacherId ?? classroom.teacherId ?? 'teacher',
        name: 'Teacher',
        role: 'teacher',
      },
      classroomId: classroom.id,
      classroomName: classroom.name,
      attachments: courseworkAttachments(work),
      commentCount: 0,
      isPinned: false,
      canPin: false,
      canComment: true,
      dueAt: work.dueAt,
      badges,
      insight: null,
      announcementId: null,
      courseworkId: work.id,
      publishStatus: work.status,
      scheduledFor: work.scheduledFor,
      canManageSchedule: false,
    }
  })

  const insightEvents: TimelineEvent[] = insights.map((insight) => ({
    id: `insight:${insight.id}`,
    type: 'ai-insight',
    timestamp: insight.detectedAt,
    title: insight.title,
    body: insight.explanation,
    author: { id: 'roognis', name: 'Roognis', role: 'system' },
    classroomId: classroom.id,
    classroomName: classroom.name,
    attachments: [],
    commentCount: 0,
    isPinned: false,
    canPin: false,
    canComment: false,
    dueAt: null,
    badges: [insight.priority, `${Math.round(insight.confidence.score * 100)}% confident`],
    insight,
    announcementId: null,
    courseworkId: null,
    publishStatus: null,
    scheduledFor: null,
    canManageSchedule: false,
  }))

  return [...announcementEvents, ...courseworkEvents, ...insightEvents].sort(
    (a, b) => timeOf(b.timestamp) - timeOf(a.timestamp),
  )
}

/* ── Filtering and search ─────────────────────────────────────────────────── */

export function filterEvents(
  events: readonly TimelineEvent[],
  filter: TimelineFilterId,
  bookmarkedIds: ReadonlySet<string> = new Set(),
): readonly TimelineEvent[] {
  if (filter === 'all') return events
  // "Pinned" means anything the teacher marked: pinned by the LMS, or
  // bookmarked locally. Both are deliberate acts of keeping something.
  if (filter === 'pinned') {
    return events.filter((event) => event.isPinned || bookmarkedIds.has(event.id))
  }
  const spec = TIMELINE_FILTERS.find((entry) => entry.id === filter)
  if (!spec || spec.types.length === 0) return events
  const allowed = new Set<TimelineEventType>(spec.types)
  return events.filter((event) => allowed.has(event.type))
}

export function searchEvents(
  events: readonly TimelineEvent[],
  query: string,
): readonly TimelineEvent[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return events
  return events.filter((event) =>
    [event.title, event.body, event.author.name, ...event.attachments.map((a) => a.title)]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
}

/** Counts per chip, so a filter can show how much it would reveal. */
export function filterCounts(
  events: readonly TimelineEvent[],
  bookmarkedIds: ReadonlySet<string> = new Set(),
): Readonly<Record<TimelineFilterId, number>> {
  const counts = {} as Record<TimelineFilterId, number>
  for (const spec of TIMELINE_FILTERS) {
    counts[spec.id] = filterEvents(events, spec.id, bookmarkedIds).length
  }
  return counts
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

const dayKey = (iso: string): string => {
  const date = parseApiDate(iso) ?? new Date(0)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const dayLabel = (key: string): string => {
  const date = new Date(`${key}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const offset = Math.round((date.getTime() - today.getTime()) / 86_400_000)
  if (offset === 0) return 'Today'
  if (offset === -1) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/**
 * Group the *visible window* into months and days.
 *
 * Grouping runs after paging, not before, so the sticky month header always
 * describes what is actually on screen.
 */
export function groupByMonth(events: readonly TimelineEvent[]): readonly TimelineMonthGroup[] {
  const months = new Map<string, Map<string, TimelineEvent[]>>()

  for (const event of events) {
    const day = dayKey(event.timestamp)
    const month = day.slice(0, 7)
    let days = months.get(month)
    if (!days) {
      days = new Map()
      months.set(month, days)
    }
    const bucket = days.get(day)
    if (bucket) bucket.push(event)
    else days.set(day, [event])
  }

  return [...months.entries()].map(([month, days]) => {
    const dayGroups: TimelineDayGroup[] = [...days.entries()].map(([date, dayEvents]) => ({
      date,
      label: dayLabel(date),
      events: dayEvents,
    }))

    return {
      month,
      label: new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
      days: dayGroups,
    }
  })
}
