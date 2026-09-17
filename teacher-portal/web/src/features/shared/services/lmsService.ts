/**
 * Typed access to `services/lms`.
 *
 * Reads go through `guardRoster` so every payload passes the §12 construct scan
 * on its way in. Writes go straight to the shared `api` client. Paths here are
 * exactly the routes registered in `services/lms/main.py`, `stream.py`,
 * `discussions.py`, `gradebook.py` and `calendar_view.py` — nothing speculative.
 */

import { api } from '../../../api/client'
import { guardRoster } from './privacyGuard'
import type {
  Announcement,
  AnnouncementAttachment,
  AnnouncementsResponse,
  BulkArchiveResponse,
  BulkRosterResponse,
  CalendarResponse,
  CalendarScheduledEvent,
  Chapter,
  ChaptersResponse,
  ClassFactsSnapshotResponse,
  Classroom,
  ClassroomGroup,
  ClassroomsResponse,
  Comment,
  CommentsResponse,
  Coursework,
  CourseworkResponse,
  CourseworkType,
  Gradebook,
  GradeHistoryResponse,
  GroupsResponse,
  Guardian,
  GuardiansResponse,
  GuardianStudent,
  GuardianStudentsResponse,
  GuardianSummaryResponse,
  MissingWorkResponse,
  NotificationsResponse,
  PendingEnrollmentsResponse,
  Rubric,
  RubricCriterion,
  RubricsResponse,
  RubricScore,
  StudentClassesResponse,
  StudentMembership,
  StudentsResponse,
  StudentTodoResponse,
  Submission,
  SubmissionsResponse,
  TeacherTodoResponse,
  Term,
  TermsResponse,
  Topic,
  TopicsResponse,
} from '../types/lms'

const enc = encodeURIComponent

/* ── Classrooms ───────────────────────────────────────────────────────────── */

/** Sprint 4, P1: `limit` is optional — the server's own default (no cap)
 * keeps every existing caller (calendar, the sidebar's classroom picker)
 * working unchanged; only the classroom grid itself (the multi-course
 * landing page, and the one list route in this service with no bound
 * before this) passes it explicitly. */
export async function listTeacherClassrooms(
  termId?: string,
  limit?: number,
): Promise<readonly Classroom[]> {
  const params = new URLSearchParams()
  if (termId) params.set('termId', termId)
  if (limit != null) params.set('limit', String(limit))
  const query = params.toString()
  const res = await guardRoster<ClassroomsResponse>(`/lms/classrooms${query ? `?${query}` : ''}`)
  return res.classrooms ?? []
}

export async function listStudentClassrooms(termId?: string): Promise<readonly Classroom[]> {
  const path = termId ? `/lms/student/classrooms?termId=${enc(termId)}` : '/lms/student/classrooms'
  const res = await guardRoster<ClassroomsResponse>(path)
  return res.classrooms ?? []
}

export function getClassroom(classroomId: string): Promise<Classroom> {
  return guardRoster<Classroom>(`/lms/classrooms/${enc(classroomId)}`)
}

export interface CreateClassroomInput {
  readonly name: string
  readonly subject: string
  readonly section?: string
  readonly room?: string
  readonly grade?: string
  readonly description?: string
  readonly color?: string
  readonly termId?: string
  readonly requireApproval?: boolean
}

export function createClassroom(input: CreateClassroomInput): Promise<Classroom> {
  return api.post<Classroom>('/lms/classrooms', input)
}

export function joinClassroomByCode(joinCode: string): Promise<{ status: string; classroom: Classroom }> {
  return api.post('/lms/enrollments/join', { joinCode })
}

export async function listClassroomStudents(classroomId: string) {
  const res = await guardRoster<StudentsResponse>(`/lms/classrooms/${enc(classroomId)}/students`)
  return res.students ?? []
}

export async function listPendingEnrollments(classroomId: string): Promise<readonly StudentMembership[]> {
  const res = await guardRoster<PendingEnrollmentsResponse>(
    `/lms/classrooms/${enc(classroomId)}/enrollments/pending`,
  )
  return res.pending ?? []
}

export function approveEnrollment(classroomId: string, studentId: string): Promise<unknown> {
  return api.post(`/lms/classrooms/${enc(classroomId)}/enrollments/${enc(studentId)}/approve`)
}

export function rejectEnrollment(classroomId: string, studentId: string): Promise<unknown> {
  return api.post(`/lms/classrooms/${enc(classroomId)}/enrollments/${enc(studentId)}/reject`)
}

export function removeStudent(classroomId: string, studentId: string): Promise<unknown> {
  return api.del(`/lms/classrooms/${enc(classroomId)}/students/${enc(studentId)}`)
}

export interface UpdateClassroomSettingsInput {
  readonly requireApproval?: boolean
  readonly streamPermission?: 'post_and_comment' | 'comment_only' | 'teachers_only'
}

export function updateClassroomSettings(
  classroomId: string,
  input: UpdateClassroomSettingsInput,
): Promise<Classroom> {
  return api.patch<Classroom>(`/lms/classrooms/${enc(classroomId)}`, { settings: input })
}

/* ── Co-teachers ──────────────────────────────────────────────────────────── */

export interface CoTeacher {
  readonly userId: string
  readonly name: string | null
  readonly joinedAt: string | null
}

export async function listCoTeachers(classroomId: string): Promise<readonly CoTeacher[]> {
  const res = await guardRoster<{ coTeachers: readonly CoTeacher[] }>(
    `/lms/classrooms/${enc(classroomId)}/co-teachers`,
  )
  return res.coTeachers ?? []
}

export function addCoTeacher(classroomId: string, email: string): Promise<CoTeacher> {
  return api.post<CoTeacher>(`/lms/classrooms/${enc(classroomId)}/co-teachers`, { email })
}

export function removeCoTeacher(classroomId: string, userId: string): Promise<unknown> {
  return api.del(`/lms/classrooms/${enc(classroomId)}/co-teachers/${enc(userId)}`)
}

/** Sprint 2, P1 — resolves synchronously against an existing student
 * account (see student_invitations.py for why: no email-sending
 * infrastructure exists in this codebase). Enrolls immediately on success. */
export function inviteStudentByEmail(classroomId: string, email: string): Promise<StudentMembership> {
  return api.post<StudentMembership>(`/lms/classrooms/${enc(classroomId)}/students/invite`, { email })
}

/* ── Roster ops at scale (Sprint 3, P1 — no consumer until Sprint 4, P1) ──── */

export interface BulkArchiveInput {
  readonly classroomIds?: readonly string[]
  /** Archives every classroom in this term (union'd with `classroomIds` if
   * both are given) — "archive last year" in one request. */
  readonly termId?: string
  /** Defaults to `true` server-side; pass `false` to unarchive instead. */
  readonly archived?: boolean
}

export function bulkArchiveClassrooms(input: BulkArchiveInput): Promise<BulkArchiveResponse> {
  return api.post<BulkArchiveResponse>('/lms/classrooms/bulk-archive', input)
}

/** Every class *this teacher* teaches that `studentId` is enrolled in —
 * never a school-wide directory (see `roster_ops.py::get_student_classes`).
 * Powers "this student is also in your other section" from a roster row. */
export function getStudentClasses(studentId: string): Promise<StudentClassesResponse> {
  return guardRoster<StudentClassesResponse>(`/lms/students/${enc(studentId)}`)
}

/** Adds one already-known student straight to another of the teacher's own
 * sections — the cross-class lookup's "add to another class" action, reusing
 * the same batch endpoint Sprint 3 built for a CSV-style roster import. */
export function addStudentToClassroom(
  classroomId: string,
  student: { readonly studentId: string; readonly studentName?: string | null },
): Promise<BulkRosterResponse> {
  return api.post<BulkRosterResponse>(`/lms/classrooms/${enc(classroomId)}/students/bulk`, {
    add: [{ studentId: student.studentId, studentName: student.studentName ?? undefined }],
  })
}

/* ── Chapters ─────────────────────────────────────────────────────────────── */

export async function listChapters(classroomId: string): Promise<readonly Chapter[]> {
  const res = await guardRoster<ChaptersResponse>(`/lms/classrooms/${enc(classroomId)}/chapters`)
  return res.chapters ?? []
}

/* ── Topics (`services/lms/topics.py`) ────────────────────────────────────────
 * Classwork-grouping topics — not `Chapter` (the knowledge-base concept) and
 * not `Coursework.topic` (the unused legacy free-text column). Any classroom
 * member can list; only a teacher of the classroom can create/rename/delete
 * (`require_teacher_of` server-side, enforced again here would be redundant —
 * the route 403s and the caller surfaces that via the normal toast path). */

export async function listTopics(classroomId: string): Promise<readonly Topic[]> {
  const res = await guardRoster<TopicsResponse>(`/lms/classrooms/${enc(classroomId)}/topics`)
  return res.topics ?? []
}

export function createTopic(classroomId: string, input: { readonly name: string }): Promise<Topic> {
  return api.post<Topic>(`/lms/classrooms/${enc(classroomId)}/topics`, input)
}

export interface UpdateTopicInput {
  readonly name?: string
  readonly orderIndex?: number
}

export function updateTopic(topicId: string, input: UpdateTopicInput): Promise<Topic> {
  return api.patch<Topic>(`/lms/topics/${enc(topicId)}`, input)
}

/** Deleting a topic does not delete or block its coursework — `topic_id` is
 * a `SET NULL` FK (`services/lms/models.py`), so every item filed under it
 * simply becomes un-filed. Callers should say exactly that, not "this
 * cannot be undone" (nothing under the topic is destroyed). */
export function deleteTopic(topicId: string): Promise<{ ok: boolean; topicId: string }> {
  return api.del(`/lms/topics/${enc(topicId)}`)
}

/** `POST /coursework/{id}/topic` — files one coursework item under a topic,
 * or clears it with `topicId: null` (`topics.py::assign_coursework_topic`).
 * Deliberately separate from `createCoursework`/`updateCoursework`: neither
 * accepts `topicId` server-side (`CreateCourseworkRequest`/
 * `UpdateCourseworkRequest` only carry the legacy free-text `topic`), so a
 * topic assignment is always a second call after the coursework exists. */
export function assignCourseworkTopic(
  courseworkId: string,
  topicId: string | null,
): Promise<{ courseworkId: string; topicId: string | null }> {
  return api.post(`/lms/coursework/${enc(courseworkId)}/topic`, { topicId })
}

/* ── Groups (Sprint 3, T2.4) ──────────────────────────────────────────────── */

export async function listGroups(classroomId: string): Promise<readonly ClassroomGroup[]> {
  const res = await guardRoster<GroupsResponse>(`/lms/classrooms/${enc(classroomId)}/groups`)
  return res.groups ?? []
}

export function createGroup(
  classroomId: string,
  input: { readonly name: string; readonly studentIds?: readonly string[] },
): Promise<ClassroomGroup> {
  return api.post<ClassroomGroup>(`/lms/classrooms/${enc(classroomId)}/groups`, input)
}

export function updateGroup(
  groupId: string,
  input: { readonly name?: string; readonly studentIds?: readonly string[] },
): Promise<ClassroomGroup> {
  return api.patch<ClassroomGroup>(`/lms/groups/${enc(groupId)}`, input)
}

export function deleteGroup(groupId: string): Promise<unknown> {
  return api.del(`/lms/groups/${enc(groupId)}`)
}

/* ── Terms ────────────────────────────────────────────────────────────────── */

export async function listTerms(): Promise<readonly Term[]> {
  const res = await guardRoster<TermsResponse>('/lms/terms')
  return res.terms ?? []
}

export interface CreateTermInput {
  readonly name: string
  readonly startDate: string
  readonly endDate: string
  readonly isCurrent?: boolean
}

export function createTerm(input: CreateTermInput): Promise<Term> {
  return api.post<Term>('/lms/terms', input)
}

/** Sprint 2, P2 / D5 — uploads a file and returns the `{type:"file",url,
 * title}` attachment entry to push into a coursework/announcement's
 * `attachments` array, same shape a "link" attachment already used. */
export function uploadAttachment(file: File): Promise<AnnouncementAttachment> {
  const formData = new FormData()
  formData.append('file', file)
  return api.upload<AnnouncementAttachment>('/lms/uploads', formData)
}

/* ── Coursework ───────────────────────────────────────────────────────────── */

export async function listCoursework(classroomId: string): Promise<readonly Coursework[]> {
  const res = await guardRoster<CourseworkResponse>(`/lms/classrooms/${enc(classroomId)}/coursework`)
  return res.coursework ?? []
}

export async function listStudentCoursework(classroomId: string): Promise<readonly Coursework[]> {
  const res = await guardRoster<CourseworkResponse>(
    `/lms/student/classrooms/${enc(classroomId)}/coursework`,
  )
  return res.coursework ?? []
}

/** Sprint 4, P3: returns the whole response (`stats` included), not just
 * `submissions` — the grading screen needs `stats` to render honest
 * progress badges, and `stats` is computed over the whole roster/coursework
 * independent of `limit`/`offset` (`main.py`'s own comment on this route).
 * `limit`/`offset` default to the server's own (100 / 0, max 200) — pass
 * them explicitly for a class that might exceed 100 rather than silently
 * truncating while `stats` still reports the whole roster. */
export function listSubmissions(
  courseworkId: string,
  options: { readonly limit?: number; readonly offset?: number } = {},
): Promise<SubmissionsResponse> {
  const params = new URLSearchParams()
  if (options.limit != null) params.set('limit', String(options.limit))
  if (options.offset != null) params.set('offset', String(options.offset))
  const query = params.toString()
  return guardRoster<SubmissionsResponse>(
    `/lms/coursework/${enc(courseworkId)}/submissions${query ? `?${query}` : ''}`,
  )
}

export interface BulkGradeInput {
  readonly grades: readonly {
    readonly submissionId: string
    readonly grade: number
    readonly feedback?: string
  }[]
  /** Defaults to `true` server-side if omitted (schemas.py). */
  readonly returnToStudent?: boolean
}

export interface BulkGradeResponse {
  readonly graded: readonly Submission[]
}

/** `POST /coursework/{id}/grades` — unreachable from any client since
 * Sprint 1 until this call site. Rejects with 400 if the coursework has a
 * rubric attached (server-side guard, Sprint 4 P3) — the caller must not
 * offer bulk grading at all for such an item rather than relying on this
 * rejection to hide the button. */
export function bulkGradeSubmissions(
  courseworkId: string,
  input: BulkGradeInput,
): Promise<BulkGradeResponse> {
  return api.post<BulkGradeResponse>(`/lms/coursework/${enc(courseworkId)}/grades`, input)
}

export interface ReturnAllGradedResponse {
  readonly returnedCount: number
  readonly submissionIds: readonly string[]
}

/** `POST /coursework/{id}/return-all` — unreachable from any client since
 * Sprint 1 until this call site. Flips every graded-but-withheld
 * submission to returned in one action, closing the backlog "Save without
 * returning" can otherwise leave with no way to flush it. */
export function returnAllGraded(courseworkId: string): Promise<ReturnAllGradedResponse> {
  return api.post<ReturnAllGradedResponse>(`/lms/coursework/${enc(courseworkId)}/return-all`)
}

export interface CreateCourseworkInput {
  readonly type: CourseworkType
  readonly title: string
  readonly description?: string | null
  readonly topic?: string
  readonly chapterId?: string
  readonly maxPoints?: number
  readonly dueAt?: string
  readonly scheduledFor?: string
  /** `schemas.py:108` accepts this on create; ClassworkTab.jsx already sends
   * it — the type just didn't say so. */
  readonly attachments?: readonly AnnouncementAttachment[]
  /** Frozen contract C1 — `None`/omitted preserves the column's `True`
   * default rather than meaning "explicitly true" (see coursework.py's
   * create_coursework). */
  readonly allowResubmission?: boolean
}

export function createCoursework(
  classroomId: string,
  input: CreateCourseworkInput,
): Promise<Coursework> {
  return api.post<Coursework>(`/lms/classrooms/${enc(classroomId)}/coursework`, input)
}

/** Teacher-only single-item fetch (`main.py`'s ownership-checked route) —
 * distinct from `listStudentCoursework`, which returns the student-visible
 * list a student's own item is found in. */
export function getCoursework(courseworkId: string): Promise<Coursework> {
  return guardRoster<Coursework>(`/lms/coursework/${enc(courseworkId)}`)
}

export interface UpdateCourseworkInput {
  readonly title?: string
  readonly description?: string | null
  readonly topic?: string
  readonly chapterId?: string
  readonly maxPoints?: number
  readonly dueAt?: string
  readonly scheduledFor?: string
  readonly attachments?: readonly AnnouncementAttachment[]
  readonly allowResubmission?: boolean
}

/** `PATCH /coursework/{id}` — the product's first edit path; the route has
 * existed since Sprint 0 with no caller. Every field is optional and
 * `None`/omitted leaves the existing value untouched (`update_coursework`'s
 * own convention), so a partial edit never has to resend the whole item. */
export function updateCoursework(
  courseworkId: string,
  input: UpdateCourseworkInput,
): Promise<Coursework> {
  return api.patch<Coursework>(`/lms/coursework/${enc(courseworkId)}`, input)
}

export interface DuplicateCourseworkInput {
  /** Omit to duplicate in place (same classroom); supply a different one
   * for the cross-section reuse case. */
  readonly classroomId?: string
  /** Omit for the server's own "<original title> (copy)" default. */
  readonly title?: string
}

/** `POST /coursework/{id}/duplicate` (Sprint 4, P2 / D17) — an ordinary
 * draft copy, not a template. See `coursework.py::duplicate_coursework`
 * for exactly what carries over and what resets. */
export function duplicateCoursework(
  courseworkId: string,
  input: DuplicateCourseworkInput = {},
): Promise<Coursework> {
  return api.post<Coursework>(`/lms/coursework/${enc(courseworkId)}/duplicate`, input)
}

export interface PublishCourseworkInput {
  /** Defaults to `'all'` server-side if the body is omitted entirely —
   * that's what kept every pre-Sprint-3 client (and any client that never
   * learns about targeting) publishing class-wide. */
  readonly targetMode?: 'all' | 'students'
  readonly studentIds?: readonly string[]
  readonly groupIds?: readonly string[]
}

/** Sprint 3 built `targetMode`/`studentIds`/`groupIds` on this route; no
 * client ever sent them until this optional param, so every publish before
 * Sprint 4 was silently class-wide regardless of what the caller intended. */
export function publishCoursework(
  courseworkId: string,
  input?: PublishCourseworkInput,
): Promise<Coursework> {
  return api.post<Coursework>(`/lms/coursework/${enc(courseworkId)}/publish`, input)
}

/** Student-only: save an in-progress answer without turning it in yet
 * (`save_coursework_draft`). Leaves the submission at `status: 'draft'`. */
export function saveCourseworkDraft(courseworkId: string, text: string): Promise<Submission> {
  return api.post<Submission>(`/lms/coursework/${enc(courseworkId)}/save`, { text })
}

/** Student-only: turn work in (`submit_coursework`) — allowed again after a
 * resubmission if `Coursework.allow_resubmission` permits it. */
export function submitCoursework(courseworkId: string, text: string): Promise<Submission> {
  return api.post<Submission>(`/lms/coursework/${enc(courseworkId)}/submit`, { text })
}

export interface GradeSubmissionInput {
  /** Exactly one of `grade`/`rubricScores` is required — GradeRequest's own
   * validator enforces it server-side; not re-encoded in the type since a
   * union-of-two-required-shapes would be heavier than the one caller
   * (`features/grading/components/GradingScreen.tsx`) needs. */
  readonly grade?: number
  readonly rubricScores?: readonly RubricScore[]
  readonly feedback?: string | null
  /** Defaults to `true` server-side (schemas.py) if omitted — Phase 4.5
   * added the "Save without returning" path, which needs `false` explicitly. */
  readonly returnToStudent?: boolean
}

export function gradeSubmission(
  submissionId: string,
  input: GradeSubmissionInput,
): Promise<Submission> {
  return api.post<Submission>(`/lms/submissions/${enc(submissionId)}/grade`, input)
}

export async function getGradeHistory(submissionId: string): Promise<GradeHistoryResponse> {
  return guardRoster<GradeHistoryResponse>(`/lms/submissions/${enc(submissionId)}/grade-history`)
}

/* ── Rubrics (`services/lms/rubrics.py`) ─────────────────────────────────────
 * Reusable, teacher-authored rubrics — create once, attach (copy) onto any
 * coursework item the teacher owns. `GradingScreen.tsx` already consumes
 * `Coursework.rubricCriteria`; these are the authoring-side calls that
 * populate it, previously unreachable from any client. */

export interface CreateRubricInput {
  readonly title: string
  readonly criteria: readonly RubricCriterion[]
}

/** `POST /lms/classrooms/{id}/rubrics` — the rubric is owned by (and only
 * ever created within) one classroom the caller teaches; reuse elsewhere
 * goes through `attachRubric`, not a second create. */
export function createRubric(classroomId: string, input: CreateRubricInput): Promise<Rubric> {
  return api.post<Rubric>(`/lms/classrooms/${enc(classroomId)}/rubrics`, input)
}

/** Every rubric authored in this one classroom (`GET
 * /lms/classrooms/{id}/rubrics`) — distinct from `listMyRubrics`, which is
 * school-wide. */
export async function listRubrics(classroomId: string): Promise<readonly Rubric[]> {
  const res = await guardRoster<RubricsResponse>(`/lms/classrooms/${enc(classroomId)}/rubrics`)
  return res.rubrics ?? []
}

/** `GET /lms/rubrics/mine` — every rubric this teacher authored across every
 * classroom they teach (Sprint 4, P2 / T2.2), school-scoped. This is the
 * read side of cross-section reuse: `attachRubric` already allows attaching
 * a rubric to a coursework item outside its home classroom as long as both
 * are in the same school. */
export async function listMyRubrics(): Promise<readonly Rubric[]> {
  const res = await guardRoster<RubricsResponse>('/lms/rubrics/mine')
  return res.rubrics ?? []
}

export interface UpdateRubricInput {
  readonly title?: string
  readonly criteria?: readonly RubricCriterion[]
}

/** `PATCH /lms/rubrics/{id}` — teacher must own the rubric (`_get_owned_rubric`).
 * Editing a rubric does not retroactively change coursework it was already
 * attached to; `attach_rubric` copies criteria by value at attach time. */
export function updateRubric(rubricId: string, input: UpdateRubricInput): Promise<Rubric> {
  return api.patch<Rubric>(`/lms/rubrics/${enc(rubricId)}`, input)
}

export function deleteRubric(rubricId: string): Promise<{ ok: boolean; rubricId: string }> {
  return api.del(`/lms/rubrics/${enc(rubricId)}`)
}

export interface AttachRubricResult {
  readonly courseworkId: string
  readonly rubric: readonly RubricCriterion[]
}

/** `POST /lms/rubrics/{id}/attach` — copies the rubric's current criteria
 * onto `coursework.rubricCriteria`. Same-school only (not same-classroom;
 * see the route's own docstring), and the caller must teach both the
 * rubric's classroom and the coursework's. There is no detach route: to
 * remove/replace a rubric on a draft, attach a different one, or leave the
 * coursework item's `rubricCriteria` as last set. */
export function attachRubric(rubricId: string, courseworkId: string): Promise<AttachRubricResult> {
  return api.post<AttachRubricResult>(`/lms/rubrics/${enc(rubricId)}/attach`, { courseworkId })
}

/* ── Stream ───────────────────────────────────────────────────────────────── */

export async function listAnnouncements(
  classroomId: string,
  limit = 100,
): Promise<readonly Announcement[]> {
  const res = await guardRoster<AnnouncementsResponse>(
    `/lms/classrooms/${enc(classroomId)}/announcements?limit=${limit}`,
  )
  return res.announcements ?? []
}

export interface CreateAnnouncementInput {
  readonly body: string
  readonly title?: string
  readonly status?: 'draft' | 'published' | 'scheduled'
  readonly scheduledFor?: string
  readonly attachments?: readonly { readonly url: string; readonly title?: string }[]
}

export function createAnnouncement(
  classroomId: string,
  input: CreateAnnouncementInput,
): Promise<Announcement> {
  return api.post<Announcement>(`/lms/classrooms/${enc(classroomId)}/announcements`, input)
}

export interface UpdateAnnouncementInput {
  readonly body?: string
  readonly title?: string
  readonly scheduledFor?: string
  readonly attachments?: readonly { readonly url: string; readonly title?: string }[]
  readonly isPinned?: boolean
}

/** `PATCH /lms/announcements/{id}` (`stream.py::update_announcement`) — lets a
 * teacher edit a not-yet-published post's text or move its `scheduledFor`
 * time before it goes out. Every field is optional and omitted fields keep
 * their current value, same convention as `updateCoursework`. */
export function updateAnnouncement(
  announcementId: string,
  input: UpdateAnnouncementInput,
): Promise<Announcement> {
  return api.patch<Announcement>(`/lms/announcements/${enc(announcementId)}`, input)
}

/** `POST /lms/announcements/{id}/publish` (`stream.py::publish_announcement`)
 * — flips a `draft`/`scheduled` post to `published` right now instead of
 * waiting for `scheduledFor`, notifying the roster immediately. Unlike
 * `publishCoursework`, announcements have no audience-targeting step, so
 * this takes no body. */
export function publishAnnouncement(announcementId: string): Promise<Announcement> {
  return api.post<Announcement>(`/lms/announcements/${enc(announcementId)}/publish`)
}

export function setAnnouncementPinned(announcementId: string, pinned: boolean): Promise<Announcement> {
  return api.post<Announcement>(`/lms/announcements/${enc(announcementId)}/pin`, { pinned })
}

export function deleteAnnouncement(announcementId: string): Promise<unknown> {
  return api.del(`/lms/announcements/${enc(announcementId)}`)
}

/* ── Comments & reactions ─────────────────────────────────────────────────── */

export async function listComments(
  classroomId: string,
  scope: {
    readonly announcementId?: string
    readonly courseworkId?: string
    /** Sprint 2, P3's fourth target — always private, the thread between a
     * teacher and one student on one submission (`discussions.py`'s own
     * docstring). */
    readonly submissionId?: string
  },
): Promise<readonly Comment[]> {
  const query = scope.announcementId
    ? `announcementId=${enc(scope.announcementId)}`
    : scope.courseworkId
      ? `courseworkId=${enc(scope.courseworkId)}`
      : scope.submissionId
        ? `submissionId=${enc(scope.submissionId)}`
        : ''
  const res = await guardRoster<CommentsResponse>(
    `/lms/classrooms/${enc(classroomId)}/comments${query ? `?${query}` : ''}`,
  )
  return res.comments ?? []
}

export function createComment(
  classroomId: string,
  input: {
    readonly body: string
    readonly announcementId?: string
    readonly courseworkId?: string
    readonly submissionId?: string
  },
): Promise<Comment> {
  return api.post<Comment>(`/lms/classrooms/${enc(classroomId)}/comments`, input)
}

export function addCommentReaction(commentId: string, emoji: string): Promise<unknown> {
  return api.post(`/lms/comments/${enc(commentId)}/reactions`, { emoji })
}

export function removeCommentReaction(commentId: string, emoji: string): Promise<unknown> {
  return api.del(`/lms/comments/${enc(commentId)}/reactions/${enc(emoji)}`)
}

/* ── Calendar, gradebook, notifications ───────────────────────────────────── */

export function getCalendar(range: { readonly start: string; readonly end: string }): Promise<CalendarResponse> {
  return guardRoster<CalendarResponse>(
    `/lms/calendar?start=${enc(range.start)}&end=${enc(range.end)}`,
  )
}

export function getGradebook(classroomId: string): Promise<Gradebook> {
  return guardRoster<Gradebook>(`/lms/classrooms/${enc(classroomId)}/gradebook`)
}

/** Sprint 3, T4.2 — the batched snapshot `loadClassSnapshot` (classFacts.ts)
 * consumes instead of fanning out to roster + coursework + gradebook +
 * per-task submissions itself. */
export function getClassFacts(classroomId: string): Promise<ClassFactsSnapshotResponse> {
  return guardRoster<ClassFactsSnapshotResponse>(`/lms/classrooms/${enc(classroomId)}/class-facts`)
}

/** Sprint 2, P4 — teacher missing-work view: published, already-overdue
 * coursework with the roster students who still haven't turned it in. */
export function getMissingWork(classroomId: string): Promise<MissingWorkResponse> {
  return guardRoster<MissingWorkResponse>(`/lms/classrooms/${enc(classroomId)}/missing-work`)
}

/* ── Calendar events (Sprint 2, P4) ──────────────────────────────────────── */

export interface CreateCalendarEventInput {
  readonly title: string
  readonly description?: string | null
  readonly startsAt: string
  readonly endsAt?: string | null
}

export function createCalendarEvent(
  classroomId: string,
  input: CreateCalendarEventInput,
): Promise<CalendarScheduledEvent> {
  return api.post<CalendarScheduledEvent>(`/lms/classrooms/${enc(classroomId)}/calendar-events`, input)
}

export interface UpdateCalendarEventInput {
  readonly title?: string
  readonly description?: string | null
  readonly startsAt?: string
  readonly endsAt?: string | null
}

/** Backend route (`PATCH /lms/calendar-events/{id}`) has existed and been
 * tested since Sprint 2, P4 — this client wrapper did not (Phase 6.1). */
export function updateCalendarEvent(
  eventId: string,
  input: UpdateCalendarEventInput,
): Promise<CalendarScheduledEvent> {
  return api.patch<CalendarScheduledEvent>(`/lms/calendar-events/${enc(eventId)}`, input)
}

export function deleteCalendarEvent(eventId: string): Promise<unknown> {
  return api.del(`/lms/calendar-events/${enc(eventId)}`)
}

export function listNotifications(limit = 30): Promise<NotificationsResponse> {
  return guardRoster<NotificationsResponse>(`/lms/notifications?limit=${limit}`)
}

export function markAllNotificationsRead(): Promise<unknown> {
  return api.post('/lms/notifications/read-all')
}

export function markNotificationRead(notificationId: string): Promise<unknown> {
  return api.post(`/lms/notifications/${enc(notificationId)}/read`)
}

/* ── Student todo (Sprint 1, T4.3) ────────────────────────────────────────── */

export function getStudentTodo(): Promise<StudentTodoResponse> {
  return guardRoster<StudentTodoResponse>('/lms/student/todo')
}

/* ── Teacher todo (Sprint 4, P4, T4.1) ────────────────────────────────────── */

/** Everything waiting on a teacher across every classroom they own or
 * co-teach, in one request — replaces the per-class `listCoursework` fan-out
 * `useTeacherDashboard.ts` used to build the same picture. */
export function getTeacherTodo(): Promise<TeacherTodoResponse> {
  return guardRoster<TeacherTodoResponse>('/lms/teacher/todo')
}

/* ── Guardians (teacher-facing roster + redeemable codes) ────────────────────
 *
 * A teacher generates a per-student, one-time-use code (`inviteGuardian`,
 * `regenerateGuardianCode` for a lapsed one) and shares it directly with the
 * guardian — there is no email-send in this codebase. A logged-in parent
 * redeems it (`redeemGuardianCode`), which both flips the LMS-local
 * `Guardian` row to `active` and establishes the actual cross-service
 * parent↔student link in the Auth Service. */

export async function listStudentGuardians(studentId: string): Promise<readonly Guardian[]> {
  const res = await guardRoster<GuardiansResponse>(`/lms/students/${enc(studentId)}/guardians`)
  return res.guardians ?? []
}

export function inviteGuardian(studentId: string, guardianEmail: string): Promise<Guardian> {
  return api.post<Guardian>(`/lms/students/${enc(studentId)}/guardians`, { guardianEmail })
}

export function regenerateGuardianCode(guardianId: string): Promise<Guardian> {
  return api.post<Guardian>(`/lms/guardians/${enc(guardianId)}/regenerate-code`)
}

export function removeGuardian(guardianId: string): Promise<unknown> {
  return api.del(`/lms/guardians/${enc(guardianId)}`)
}

/* ── Guardian (parent role) ───────────────────────────────────────────────── */

export async function listGuardianStudents(): Promise<readonly GuardianStudent[]> {
  const res = await guardRoster<GuardianStudentsResponse>('/lms/guardian/students')
  return res.students ?? []
}

/** Redeems a code a teacher shared directly (text, printed slip — no
 * email-send flow exists). On success, the returned `Guardian` has
 * `status === "active"` and the parent's own `guardianUserId`. */
export function redeemGuardianCode(code: string): Promise<Guardian> {
  return api.post<Guardian>('/lms/guardian/redeem', { code })
}

export function getGuardianSummary(studentId: string): Promise<GuardianSummaryResponse> {
  return guardRoster<GuardianSummaryResponse>(`/lms/guardian/students/${enc(studentId)}/summary`)
}
