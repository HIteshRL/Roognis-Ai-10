import type { SubmissionStatus } from '../types/lms'

/**
 * The client-side half of Sprint 1 T3.1 / frozen contract: a grade must
 * never be shown to the student it belongs to until their submission's
 * status is `returned`. Mirrors the server's own rule exactly —
 * `serialize_submission` in `coursework.py`:
 *
 *   withhold = for_student and submission.status != SubmissionStatus.RETURNED.value
 *
 * This existed only as inline conditionals scattered across
 * `CourseworkDetail.jsx` (`StudentSubmit`'s `sub?.status === 'returned'`
 * gate) before this extraction — correct by inspection, but "verified by
 * reading the code" is exactly the gap that let Sprint 2's grade-history
 * endpoint (Phase 1.1) go two sprints without the same check: a second
 * implementation of the same rule, unaudited against the first. A pure,
 * tested selector is the one implementation both the student-facing render
 * path and any future one (a notification, an export, a mobile client) can
 * share and be checked against.
 *
 * `forStudent` is `false` for a teacher's own view of their students'
 * submissions (TeacherGrading) — a teacher may always see the grade they
 * assigned, returned or not, which is why this isn't simply
 * `status === 'returned'`.
 */
export function canRevealGrade(status: SubmissionStatus, forStudent: boolean): boolean {
  return !forStudent || status === 'returned'
}

/**
 * The gradebook-cell / grading-list distinction between "graded" and
 * "graded and handed back" (`GradebookCell.returned` in `lms.ts`,
 * `gradebook.py`'s own cell shape). A submission can carry a grade while
 * `canRevealGrade` still says no — this is what TeacherGrading's "Graded ·
 * N — not yet returned" badge (Phase 4.5) keys off of, and what the
 * gradebook's superscript marker keys off of on the cell-rendering side.
 */
export function isGradedNotReturned(status: SubmissionStatus, grade: number | null): boolean {
  return status !== 'returned' && grade != null
}
