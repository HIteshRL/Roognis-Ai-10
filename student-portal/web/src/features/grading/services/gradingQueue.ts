/**
 * Pure grading-queue logic for the large-class grading screen (Sprint 4,
 * P3, T3.2 / decision D16).
 *
 * `web/` has no component-test harness — `vite.config.js` has no `test`
 * block at all, so vitest here runs in its default `node` environment with
 * no DOM. Extracting the risky part of grading (ordering, validation,
 * rubric totals, optimistic stat updates) into pure functions makes it
 * testable without inventing one mid-sprint, the same pattern `riskRules.ts`
 * and `classFacts.ts` already established.
 *
 * Every function here is a plain `(input) => output` — no fetch, no
 * component state, no `useState`. The screen (T3.3) is a thin shell around
 * this module plus `useMutation`'s `OptimisticPatch.apply`, which is
 * already typed as exactly this kind of pure function.
 */

import { isGradedNotReturned } from '../../shared/services/withholding'
import type { RubricCriterion, Submission, SubmissionsResponse } from '../../shared/types/lms'

export interface GradeDraft {
  readonly grade?: string
  readonly feedback?: string
  /** Keyed by criterion name, mirroring `mergedRubricScores`'s merge shape. */
  readonly scores?: Readonly<Record<string, string>>
}

export type GradeDrafts = Readonly<Record<string, GradeDraft>>

/**
 * Ungraded-first, stable otherwise (`Array.prototype.sort` has been a
 * stable sort since ES2019) — so opening the queue lands a teacher on the
 * work that still needs them rather than wherever the server happened to
 * return it.
 */
export function orderForGrading(submissions: readonly Submission[]): Submission[] {
  return [...submissions].sort((a, b) => {
    const aGraded = a.grade != null ? 1 : 0
    const bGraded = b.grade != null ? 1 : 0
    return aGraded - bGraded
  })
}

/**
 * A `draft`-status row (the student saved but never turned in) is never
 * eligible for bulk selection: `list_submissions` returns it unfiltered,
 * but `submission_stats` counts it as *missing*, not turned in —
 * `CourseworkDetail.jsx`'s own `isDraft` special-case exists for exactly
 * this trap. A bulk-select that missed it would grade work nobody
 * submitted.
 */
export function bulkSelectable(submissions: readonly Submission[]): Submission[] {
  return submissions.filter((submission) => submission.status !== 'draft')
}

export interface GradeValidation {
  readonly valid: boolean
  readonly error?: string
}

/** Mirrors `grade_submission`'s own bound (`coursework.py`: grade >
 * maxPoints raises 400) so the client can refuse before a request leaves,
 * not just echo the server's rejection back. */
export function validateGrade(value: number, maxPoints: number | null): GradeValidation {
  if (!Number.isFinite(value)) return { valid: false, error: 'Enter a number.' }
  if (value < 0) return { valid: false, error: 'Grade cannot be negative.' }
  if (maxPoints != null && value > maxPoints) {
    return { valid: false, error: `Grade cannot exceed ${maxPoints}.` }
  }
  return { valid: true }
}

/** The existing per-criterion breakdown, overridden by whatever the
 * teacher has typed in this draft — same merge `TeacherGrading.scoresFor`
 * used inline before this extraction. */
export function mergedRubricScores(
  submission: Submission,
  draft: GradeDraft | undefined,
): Record<string, string> {
  const existing = Object.fromEntries(
    (submission.rubricScores ?? []).map((score) => [score.criterion, String(score.points)]),
  )
  return { ...existing, ...(draft?.scores ?? {}) }
}

export function rubricTotal(
  criteria: readonly RubricCriterion[],
  scores: Readonly<Record<string, string>>,
): number {
  return criteria.reduce((sum, criterion) => sum + (Number(scores[criterion.criterion]) || 0), 0)
}

export interface BulkGradeItem {
  readonly submissionId: string
  readonly grade: number
  readonly feedback?: string
}

export interface BulkValidationError {
  readonly submissionId: string
  readonly error: string
}

export interface BulkPayloadResult {
  readonly items: readonly BulkGradeItem[]
  readonly errors: readonly BulkValidationError[]
}

/**
 * Diffs drafts into a `BulkGradeRequest` payload — only submissions the
 * teacher actually typed a grade into are included; an untouched row is
 * left alone rather than resubmitted with its existing value.
 *
 * Validates every entered row *before* returning any items: one over-max
 * row aborts the server's whole batch (`coursework.py`'s bulk path is
 * all-or-nothing by contract), so surfacing every error up front and
 * returning zero items instead of a partial batch is what keeps a client
 * from losing 99 good grades to one bad one — client-side validation here
 * is not cosmetic.
 *
 * Callers must exclude rubric-graded coursework entirely (server-side
 * guard in `bulk_grade_submissions`; the bulk lane's semantics — "same
 * value, many students" — were never meaningful for a per-criterion
 * breakdown) — this function does not check `rubricCriteria` itself.
 */
export function toBulkPayload(
  submissions: readonly Submission[],
  drafts: GradeDrafts,
  maxPoints: number | null,
): BulkPayloadResult {
  const items: BulkGradeItem[] = []
  const errors: BulkValidationError[] = []

  for (const submission of bulkSelectable(submissions)) {
    const raw = drafts[submission.id]?.grade
    if (raw == null || raw === '') continue

    const value = Number(raw)
    const validation = validateGrade(value, maxPoints)
    if (!validation.valid) {
      errors.push({ submissionId: submission.id, error: validation.error ?? 'Invalid grade.' })
      continue
    }

    items.push({
      submissionId: submission.id,
      grade: value,
      feedback: drafts[submission.id]?.feedback ?? submission.feedback ?? undefined,
    })
  }

  return { items: errors.length > 0 ? [] : items, errors }
}

/**
 * Folds a grading response (single or bulk) back into the cached
 * `SubmissionsResponse` without a refetch. `stats` is recomputed from the
 * merged submission list using the same population and predicates the
 * server's own `submission_stats` uses — `assignedCount` alone is carried
 * over, since grading never changes the roster.
 *
 * This is exactly where Trap A bites: `graded` must **not** increment on a
 * withheld save (`returnToStudent: false` leaves `status` at `turned_in`),
 * and `gradedNotReturned` must — enforced here by reusing
 * `withholding.ts`'s `isGradedNotReturned` rather than re-deriving the rule
 * a second, unaudited time.
 */
export function applyGradedOptimistically(
  previous: SubmissionsResponse,
  graded: readonly Submission[],
): SubmissionsResponse {
  const byId = new Map(graded.map((submission) => [submission.id, submission]))
  const submissions = previous.submissions.map((submission) => byId.get(submission.id) ?? submission)
  const nonDraft = submissions.filter((submission) => submission.status !== 'draft')

  const turnedIn = nonDraft.filter((submission) => submission.status === 'turned_in').length
  const returnedCount = nonDraft.filter((submission) => submission.status === 'returned').length
  const gradedNotReturned = nonDraft.filter((submission) =>
    isGradedNotReturned(submission.status, submission.grade),
  ).length
  const missing = Math.max(0, previous.stats.assignedCount - turnedIn - returnedCount)

  return {
    ...previous,
    submissions,
    stats: {
      ...previous.stats,
      turnedIn,
      graded: returnedCount,
      gradedNotReturned,
      missing,
    },
  }
}

export interface QueueCounts {
  readonly total: number
  /** Turned in, ungraded — the population the rail's "ungraded" filter
   * shows. */
  readonly ungraded: number
  readonly gradedNotReturned: number
  readonly returned: number
  readonly draft: number
}

/** Local tally over a fetched submission list, for the rail's own counts —
 * distinct from `SubmissionStats`, which denominates against the full
 * roster (`assignedCount`) rather than what happens to be loaded. */
export function queueCounts(submissions: readonly Submission[]): QueueCounts {
  let ungraded = 0
  let gradedNotReturned = 0
  let returned = 0
  let draft = 0

  for (const submission of submissions) {
    if (submission.status === 'draft') {
      draft += 1
      continue
    }
    if (submission.status === 'returned') {
      returned += 1
      continue
    }
    if (isGradedNotReturned(submission.status, submission.grade)) {
      gradedNotReturned += 1
      continue
    }
    ungraded += 1
  }

  return { total: submissions.length, ungraded, gradedNotReturned, returned, draft }
}

/**
 * Keyboard navigation's index arithmetic, isolated because wrap-vs-clamp
 * off-by-ones are invisible in review. `wrap: true` (the rail's default)
 * cycles past either end; `wrap: false` clamps at the boundary.
 */
export function nextIndex(current: number, length: number, delta: number, wrap = true): number {
  if (length <= 0) return 0
  if (!wrap) return Math.max(0, Math.min(length - 1, current + delta))
  return ((current + delta) % length + length) % length
}
