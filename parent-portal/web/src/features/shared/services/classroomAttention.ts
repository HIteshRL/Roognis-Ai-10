/**
 * Sprint 4, P1 (T1 — multi-course management): per-classroom "does this
 * class need me" counts for the classroom grid, derived from the same
 * `GET /teacher/todo` payload the Command Center's pending-review rows
 * already read (`dashboard/services/dashboardService.ts::buildPendingReviews`).
 * A pure derivation, not a second fetch — a teacher with twelve classes
 * should see which three need them without twelve more requests.
 */

import type { TeacherTodoResponse } from '../types/lms'

export interface ClassroomAttention {
  /** Published, turned-in submissions awaiting a first grade. */
  readonly ungraded: number
  /** Grades saved with `returnToStudent: false` and never returned. */
  readonly heldGrades: number
  /** Overdue work nobody has turned in. */
  readonly missing: number
  /** Students waiting on an enrollment decision. */
  readonly pendingEnrollments: number
  /** The four above, summed — what the grid's badge actually shows. */
  readonly total: number
}

const EMPTY: ClassroomAttention = { ungraded: 0, heldGrades: 0, missing: 0, pendingEnrollments: 0, total: 0 }

interface MutableAttention {
  ungraded: number
  heldGrades: number
  missing: number
  pendingEnrollments: number
}

function bucket(map: Map<string, MutableAttention>, classroomId: string): MutableAttention {
  const existing = map.get(classroomId)
  if (existing) return existing
  const created: MutableAttention = { ungraded: 0, heldGrades: 0, missing: 0, pendingEnrollments: 0 }
  map.set(classroomId, created)
  return created
}

export function buildClassroomAttention(
  todo: TeacherTodoResponse | null,
): ReadonlyMap<string, ClassroomAttention> {
  const working = new Map<string, MutableAttention>()

  for (const work of todo?.coursework ?? []) {
    if (!work.stats || work.status !== 'published') continue
    if (work.stats.turnedIn > 0) bucket(working, work.classroomId).ungraded += work.stats.turnedIn
    if (work.stats.gradedNotReturned > 0) {
      bucket(working, work.classroomId).heldGrades += work.stats.gradedNotReturned
    }
  }

  for (const item of todo?.missingWork.items ?? []) {
    bucket(working, item.classroomId).missing += item.missingCount
  }

  for (const row of todo?.pendingEnrollments ?? []) {
    bucket(working, row.classroomId).pendingEnrollments += row.count
  }

  const result = new Map<string, ClassroomAttention>()
  for (const [classroomId, counts] of working) {
    result.set(classroomId, { ...counts, total: counts.ungraded + counts.heldGrades + counts.missing + counts.pendingEnrollments })
  }
  return result
}

export function attentionFor(
  byClassroom: ReadonlyMap<string, ClassroomAttention>,
  classroomId: string,
): ClassroomAttention {
  return byClassroom.get(classroomId) ?? EMPTY
}
