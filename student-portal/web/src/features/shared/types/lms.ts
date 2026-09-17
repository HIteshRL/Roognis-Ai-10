/**
 * The LMS wire contract, transcribed from the service's own serializers so the
 * frontend and `services/lms` cannot drift silently:
 *
 *   classrooms.py  → serialize_classroom / serialize_student_classroom
 *   coursework.py  → serialize_coursework / serialize_submission / submission_stats
 *   stream.py      → serialize_announcement
 *   discussions.py → comments and reactions
 *   notifications.py → serialize_notification
 *   calendar_view.py → GET /api/lms/calendar
 *
 * Optional fields are optional because the serializer omits them for some
 * roles, not because they are unreliable.
 */

export type CourseworkType = 'assignment' | 'quiz' | 'material' | 'question'
export type CourseworkStatus = 'draft' | 'published' | 'scheduled'
export type SubmissionStatus = 'draft' | 'assigned' | 'turned_in' | 'returned'
export type AnnouncementStatus = 'draft' | 'published' | 'scheduled'

export interface Classroom {
  readonly id: string
  readonly schoolId?: string
  readonly teacherId?: string
  readonly termId?: string | null
  readonly name: string
  readonly subject: string | null
  readonly section: string | null
  readonly room?: string | null
  readonly grade: string | null
  readonly description?: string | null
  readonly color: string | null
  readonly joinCode?: string | null
  readonly joinCodeEnabled?: boolean
  readonly isArchived?: boolean
  readonly settings?: Readonly<Record<string, unknown>>
  readonly studentCount?: number
  readonly chapterCount?: number
  readonly createdAt?: string | null
  readonly updatedAt?: string | null
}

/** Sprint 1, T3.2 / frozen contract C2 — denominators derived from the
 * roster, not from materialized rows. `assignedCount` is the roster size;
 * `missing` excludes both `turnedIn` and `graded` (a returned submission
 * was turned in at some point, so it's never "missing").
 *
 * Sprint 4, P3 (C2 amendment): `graded` means "returned", not "graded" — a
 * submission saved with `returnToStudent=false` leaves `status` at
 * `turned_in`, so it can never show up in `graded`. `gradedNotReturned`
 * covers exactly that population (`grade` set, not yet returned). */
export interface SubmissionStats {
  readonly assignedCount: number
  readonly turnedIn: number
  readonly graded: number
  readonly gradedNotReturned: number
  readonly missing: number
}

export interface RubricCriterion {
  readonly criterion: string
  readonly description?: string | null
  readonly maxPoints: number
}

export interface RubricScore {
  readonly criterion: string
  readonly points: number
}

/** A reusable, teacher-authored rubric (`services/lms/rubrics.py`,
 * `serialize_rubric`). `criteria` is a flat single-point-per-criterion list —
 * there is no nested point-level/descriptor structure in this backend, unlike
 * a full Google-Classroom-style multi-level rubric. `maxPoints` is the
 * server-computed sum of every criterion's `maxPoints`, not an independently
 * editable field. Attaching a rubric to coursework (`attach_rubric`) copies
 * `criteria` onto `Coursework.rubricCriteria` by value, so a `Rubric` row has
 * no back-reference to the coursework items it was attached to. */
export interface Rubric {
  readonly id: string
  readonly classroomId: string
  readonly title: string
  readonly criteria: readonly RubricCriterion[]
  readonly maxPoints: number
  readonly createdAt: string | null
}

export interface RubricsResponse {
  readonly rubrics: readonly Rubric[]
}

export interface Coursework {
  readonly quizId?: string | null
  readonly id: string
  readonly classroomId: string
  readonly chapterId: string | null
  readonly schoolId?: string
  readonly teacherId?: string
  readonly type: CourseworkType
  readonly title: string
  readonly description: string | null
  readonly topic: string | null
  readonly topicId: string | null
  readonly maxPoints: number | null
  readonly dueAt: string | null
  readonly status: CourseworkStatus
  readonly scheduledFor: string | null
  readonly publishedAt: string | null
  readonly allowResubmission: boolean
  /** List shape (Sprint 1, T2.3) — matches Announcement.attachments exactly,
   * both render through TimelineAttachment.tsx. */
  readonly attachments: readonly AnnouncementAttachment[]
  /** A rubric's criteria, copied in by rubrics.py's attach_rubric. Its own
   * field, separate from attachments — null when no rubric is attached. */
  readonly rubricCriteria: readonly RubricCriterion[] | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  /** Teacher listings only. */
  readonly submissionStats?: SubmissionStats
  /** Student listings only; explicitly null before the student submits. */
  readonly mySubmission?: Submission | null
}

export interface Submission {
  readonly id: string
  readonly courseworkId: string
  readonly studentId: string
  readonly studentName: string | null
  readonly status: SubmissionStatus
  /** Set once, at turn-in time, by comparing turnedInAt against the
   * coursework's dueAt at that instant — not a derived/live property.
   * Stays alongside `status` rather than folding into it (`status` is
   * still just 'turned_in') to minimize blast radius on the many places
   * that already branch on `status === 'turned_in'`. Not recomputed if a
   * teacher edits the coursework's due date after the fact — see
   * `services/lms/coursework.py::submit_coursework`. */
  readonly isLate: boolean
  readonly content: Readonly<Record<string, unknown>>
  readonly grade: number | null
  readonly feedback: string | null
  /** Sprint 1, T3.4 — set only when graded against the coursework's
   * attached rubric. Withheld under the same for_student/returned rule as
   * grade/feedback (T3.1). */
  readonly rubricScores: readonly RubricScore[] | null
  readonly turnedInAt: string | null
  readonly gradedAt: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface AnnouncementAttachment {
  readonly url?: string
  readonly title?: string
  readonly type?: string
  readonly [key: string]: unknown
}

export interface Announcement {
  readonly id: string
  readonly classroomId: string
  readonly authorId: string
  readonly authorName: string
  readonly title: string | null
  readonly body: string
  readonly attachments: readonly AnnouncementAttachment[]
  readonly status: AnnouncementStatus
  readonly scheduledFor: string | null
  readonly isPinned: boolean
  readonly publishedAt: string | null
  readonly commentCount: number
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface Comment {
  readonly id: string
  readonly classroomId: string
  readonly announcementId: string | null
  readonly courseworkId: string | null
  /** Sprint 2, P3's fourth target — always private (`discussions.py`). */
  readonly submissionId: string | null
  readonly authorId: string
  readonly authorName: string | null
  readonly body: string
  readonly createdAt: string | null
  readonly reactions?: Readonly<Record<string, number>>
}

export interface StudentMembership {
  readonly studentId: string
  readonly studentName: string | null
  readonly email?: string | null
  readonly status?: string
}

/** Sprint 3, T2.4 — a teacher-defined subset of a classroom's roster, for
 * targeting coursework at a group rather than every student or a hand-picked
 * list each time. Membership has no effect on anything already published
 * (decision D9) — a group is resolved to student ids once, at publish time. */
export interface ClassroomGroup {
  readonly id: string
  readonly classroomId: string
  readonly name: string
  readonly studentIds: readonly string[]
  readonly createdAt: string | null
}

export interface GroupsResponse {
  readonly groups: readonly ClassroomGroup[]
}

/** A classwork topic (`services/lms/topics.py`) — a teacher-owned grouping
 * coursework is filed under, distinct from `Chapter` (a knowledge-base unit).
 * Deleting a topic does not delete or block its coursework: `topic_id` is a
 * `SET NULL` foreign key (`models.py`), so affected items simply become
 * un-filed. `orderIndex` is server-assigned (append-to-end on create) and
 * only otherwise changed via an explicit `PATCH` with `orderIndex`. */
export interface Topic {
  readonly id: string
  readonly classroomId: string
  readonly name: string
  readonly orderIndex: number
  readonly createdAt: string | null
}

export interface TopicsResponse {
  readonly topics: readonly Topic[]
}

/** A classroom's own knowledge-base chapter (distinct from `topic`/`topicId`,
 * the lighter classwork-grouping concept) — `Coursework.chapterId` links an
 * assignment to one, e.g. for chapter-scoped progress tracking. */
export interface Chapter {
  readonly id: string
  readonly classroomId: string
  readonly knowledgeBaseId: string | null
  readonly title: string
  readonly description: string | null
  readonly orderIndex: number
  readonly isPublished: boolean
  readonly documentCount: number
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface ChaptersResponse {
  readonly chapters: readonly Chapter[]
}

export interface LmsNotification {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly body: string
  readonly data: Readonly<Record<string, unknown>>
  readonly isRead: boolean
  readonly createdAt: string | null
}

export interface CalendarCourseworkEntry {
  readonly kind: 'coursework'
  readonly courseworkId: string
  readonly classroomId: string
  readonly classroomName: string | null
  readonly title: string
  readonly type: CourseworkType
  readonly dueAt: string
  readonly maxPoints: number | null
}

/** Sprint 2, P4 — a one-off `CalendarEvent` row (exam, field trip), merged
 * into the same aggregate alongside coursework due-dates. */
export interface CalendarScheduledEvent {
  readonly kind: 'event'
  readonly eventId: string
  readonly classroomId: string
  readonly classroomName: string | null
  readonly title: string
  readonly description: string | null
  readonly dueAt: string
  readonly endsAt: string | null
}

export type CalendarEventDto = CalendarCourseworkEntry | CalendarScheduledEvent

export interface CalendarDay {
  readonly date: string
  readonly events: readonly CalendarEventDto[]
}

export interface CalendarResponse {
  readonly start: string
  readonly end: string
  readonly days: readonly CalendarDay[]
  readonly total: number
}

/** Sprint 2, P4 — teacher missing-work view. */
export interface MissingWorkStudent {
  readonly studentId: string
  readonly studentName: string
}

export interface MissingWorkItem {
  readonly courseworkId: string
  readonly title: string
  readonly dueAt: string
  readonly missingCount: number
  readonly missingStudents: readonly MissingWorkStudent[]
}

export interface MissingWorkResponse {
  readonly classroomId: string
  readonly generatedAt: string
  readonly items: readonly MissingWorkItem[]
  readonly totalMissing: number
}

export interface GradebookColumn {
  readonly courseworkId: string
  readonly title: string
  readonly type: CourseworkType
  readonly maxPoints: number | null
  readonly dueAt: string | null
}

/**
 * One cell of the gradebook.
 *
 * `gradebook.py` emits a cell for *every* student × published-gradeable task,
 * using the synthetic status `"missing"` where no submission row exists. That
 * makes the gradebook a complete, positive record of non-submission across the
 * whole class — which is why it, and not the sampled submission window, is the
 * authority on what is missing.
 *
 * `score` stays null until the work is graded; `returned` distinguishes
 * "graded" from "graded and handed back".
 */
export interface GradebookCell {
  readonly status: SubmissionStatus | 'missing'
  readonly score: number | null
  readonly returned: boolean
}

export interface GradebookRow {
  readonly studentId: string
  readonly studentName: string | null
  /** Keyed by coursework id. Absent key = no submission record at all. */
  readonly cells: Readonly<Record<string, GradebookCell | undefined>>
  readonly averagePercent: number | null
}

export interface Gradebook {
  readonly classroomId: string
  readonly columns: readonly GradebookColumn[]
  readonly rows: readonly GradebookRow[]
  readonly classAveragePercent: number | null
  readonly studentCount: number
}

/* ── Envelope shapes ──────────────────────────────────────────────────────── */

export interface ClassroomsResponse {
  readonly classrooms: readonly Classroom[]
}

/** Sprint 2, P1 — a school-scoped academic term. Not per-teacher: any
 * teacher in the school can see and assign it. */
export interface Term {
  readonly id: string
  readonly schoolId: string
  readonly name: string
  readonly startDate: string
  readonly endDate: string
  readonly isCurrent: boolean
  readonly createdAt?: string | null
}

export interface TermsResponse {
  readonly terms: readonly Term[]
}
export interface CourseworkResponse {
  readonly coursework: readonly Coursework[]
}
export interface SubmissionsResponse {
  readonly courseworkId: string
  readonly stats: SubmissionStats
  readonly submissions: readonly Submission[]
}

/** Sprint 3, T4.2 — the whole of classFacts.ts's `ClassSnapshot` built
 * server-side in one request: `GET /classrooms/{id}/class-facts`. Mirrors
 * `services/lms/gradebook.py::build_class_facts_snapshot` exactly, so
 * `loadClassSnapshot` only has to reshape this into `ClassSnapshot`, not
 * fan out to four separate endpoints itself. */
export interface ClassFactsSnapshotResponse {
  readonly classroom: Classroom
  readonly students: readonly StudentMembership[]
  readonly coursework: readonly Coursework[]
  readonly submissionsByCoursework: Readonly<Record<string, readonly Submission[]>>
  readonly gradebook: Gradebook
  readonly detailedCourseworkIds: readonly string[]
}

/** One append-only row per `grade_submission` call (Sprint 2, P3). A
 * student's own history omits any entry with `returned: false` — the
 * server never sends a withheld grade to the student it belongs to, so
 * there is no client-side filtering to replicate here (Phase 1.1's fix is
 * server-side; the shape below is simply what actually arrives). */
export interface GradeHistoryEntry {
  readonly id: string
  readonly submissionId: string
  readonly gradedBy: string
  readonly grade: number | null
  readonly feedback: string | null
  readonly rubricScores: readonly RubricScore[] | null
  readonly returned: boolean
  /** True only for a row `backfill_grade_history.py` manufactured from a
   * submission's current state (Phase 6.2) — never true for a row written
   * by an actual `grade_submission` call. A backfilled row reflects only
   * the submission's state *at backfill time*, not a specific grading
   * event (there is no record of what an earlier re-grade changed). */
  readonly isBackfilled: boolean
  readonly createdAt: string | null
}

export interface GradeHistoryResponse {
  readonly submissionId: string
  readonly history: readonly GradeHistoryEntry[]
}
export interface AnnouncementsResponse {
  readonly announcements: readonly Announcement[]
}
export interface CommentsResponse {
  readonly comments: readonly Comment[]
}
export interface StudentsResponse {
  readonly students: readonly StudentMembership[]
}
export interface PendingEnrollmentsResponse {
  readonly pending: readonly StudentMembership[]
}
export interface NotificationsResponse {
  readonly notifications: readonly LmsNotification[]
  readonly unreadCount: number
}

/**
 * Sprint 1, T4.3 — `GET /student/todo`. One entry per coursework item;
 * the optional fields are only populated on the bucket where they're
 * meaningful (`score`/`maxPoints`/`gradedAt` on `recentlyGraded`,
 * `turnedInAt` on `recentlySubmitted`).
 */
export interface TodoItem {
  readonly courseworkId: string
  readonly classroomId: string
  readonly classroomName: string | null
  readonly title: string
  readonly type: CourseworkType
  readonly dueAt: string | null
  readonly score?: number | null
  readonly maxPoints?: number | null
  readonly gradedAt?: string | null
  readonly turnedInAt?: string | null
}

export interface StudentTodoResponse {
  readonly dueToday: readonly TodoItem[]
  readonly upcoming: readonly TodoItem[]
  readonly overdue: readonly TodoItem[]
  readonly missing: readonly TodoItem[]
  readonly recentlySubmitted: readonly TodoItem[]
  readonly recentlyGraded: readonly TodoItem[]
  readonly generatedAt: string
}

/** A guardian's linked student — `guardians.py::guardian_students`, enriched
 * with a display name from any active enrollment in the guardian's school. */
export interface GuardianStudent {
  readonly studentId: string
  readonly studentName: string | null
}

export interface GuardianStudentsResponse {
  readonly students: readonly GuardianStudent[]
}

/** `guardians.py::serialize_guardian` — one guardian↔student invite/link row.
 * `code`/`codeExpiresAt`/`codeExpired` are only present while `status ===
 * "pending"`: a redeemed or removed row's old code is spent and is not
 * surfaced back (see the field's own comment in `guardians.py`). */
export interface Guardian {
  readonly id: string
  readonly studentId: string
  readonly guardianEmail: string
  readonly guardianUserId: string | null
  readonly status: 'pending' | 'active' | 'removed'
  readonly createdAt: string | null
  readonly code?: string
  readonly codeExpiresAt?: string | null
  readonly codeExpired?: boolean
}

export interface GuardiansResponse {
  readonly guardians: readonly Guardian[]
}

/** `guardians.py::guardian_summary` shares `student_progress_facts` with
 * `GET /student/todo`, so its buckets are `TodoItem`s too — `upcoming` here
 * is the *unbounded* window (today + 7-day + later), not `student/todo`'s
 * 7-day cap. */
export interface GuardianSummaryResponse {
  readonly studentId: string
  readonly upcoming: readonly TodoItem[]
  readonly missing: readonly TodoItem[]
  readonly recentGrades: readonly TodoItem[]
  readonly generatedAt: string
}

/** Sprint 4, P4 (T4.1) — `GET /teacher/todo`'s per-item stats. Identical
 * shape to `SubmissionStats`, but correlated across every classroom the
 * teacher owns or co-teaches in one request rather than one per class —
 * see `coursework.py::submission_stats_bulk`'s Sprint 4 docstring for why
 * that took a real rewrite, not a parameter swap. */
export interface TeacherTodoStats {
  readonly assignedCount: number
  readonly turnedIn: number
  readonly graded: number
  readonly gradedNotReturned: number
  readonly missing: number
}

/** `stats` is `null` for a `draft`/`scheduled` item (nothing to grade yet)
 * or a published `material` (never gradeable) — the same three cases
 * `main.py`'s teacher_todo_facts skips assigning stats to. */
export interface TeacherTodoCourseworkEntry {
  readonly classroomId: string
  readonly classroomName: string
  readonly courseworkId: string
  readonly title: string
  readonly type: CourseworkType
  readonly status: CourseworkStatus
  readonly dueAt: string | null
  readonly scheduledFor: string | null
  readonly createdAt: string | null
  readonly stats: TeacherTodoStats | null
}

export interface TeacherTodoPendingEnrollment {
  readonly classroomId: string
  readonly classroomName: string
  readonly count: number
}

export interface TeacherTodoMissingWorkItem {
  readonly classroomId: string
  readonly classroomName: string
  readonly courseworkId: string
  readonly title: string
  readonly dueAt: string
  readonly missingCount: number
  readonly missingStudents: readonly { readonly studentId: string; readonly studentName: string }[]
}

export interface TeacherTodoMissingWork {
  readonly items: readonly TeacherTodoMissingWorkItem[]
  readonly totalMissing: number
}

export interface TeacherTodoResponse {
  readonly coursework: readonly TeacherTodoCourseworkEntry[]
  readonly pendingEnrollments: readonly TeacherTodoPendingEnrollment[]
  readonly missingWork: TeacherTodoMissingWork
  readonly generatedAt: string
}

/** Sprint 4, P1 — `POST /classrooms/bulk-archive`'s response. A classroom
 * the caller doesn't own is skipped and named here rather than failing
 * the whole batch, so one stale id in a long list doesn't block the rest. */
export interface BulkArchiveResponse {
  readonly archived: readonly string[]
  readonly skipped: readonly string[]
}

/** Sprint 4, P1 — `GET /students/{id}`'s cross-class view: every class
 * *this teacher* teaches that the named student is enrolled in (never a
 * school-wide directory — see `roster_ops.py::get_student_classes`). */
export interface StudentClassEntry {
  readonly classroomId: string
  readonly name: string
  readonly subject: string
  readonly isArchived: boolean
  readonly joinedAt: string | null
}

export interface StudentClassesResponse {
  readonly studentId: string
  readonly classrooms: readonly StudentClassEntry[]
}

/** Sprint 3, P1 — `POST /classrooms/{id}/students/bulk`'s response. A
 * student who couldn't be added/removed (already enrolled, not found) is
 * named in the matching `*Skipped` list rather than failing the batch. */
export interface BulkRosterResponse {
  readonly added: readonly string[]
  readonly addSkipped: readonly string[]
  readonly removed: readonly string[]
  readonly removeSkipped: readonly string[]
}
