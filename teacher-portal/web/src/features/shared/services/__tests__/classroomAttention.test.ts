import { describe, expect, it } from 'vitest'
import type {
  TeacherTodoCourseworkEntry,
  TeacherTodoResponse,
  TeacherTodoStats,
} from '../../types/lms'
import { attentionFor, buildClassroomAttention } from '../classroomAttention'

const stats = (overrides: Partial<TeacherTodoStats> = {}): TeacherTodoStats => ({
  assignedCount: 10,
  turnedIn: 0,
  graded: 0,
  gradedNotReturned: 0,
  missing: 0,
  ...overrides,
})

const work = (overrides: Partial<TeacherTodoCourseworkEntry> & { courseworkId: string }): TeacherTodoCourseworkEntry => ({
  classroomId: 'c1',
  classroomName: 'Class 1',
  title: `Task ${overrides.courseworkId}`,
  type: 'assignment',
  status: 'published',
  dueAt: null,
  scheduledFor: null,
  createdAt: '2026-01-01T00:00:00Z',
  stats: stats(),
  ...overrides,
})

const todo = (overrides: Partial<TeacherTodoResponse> = {}): TeacherTodoResponse => ({
  coursework: [],
  pendingEnrollments: [],
  missingWork: { items: [], totalMissing: 0 },
  generatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('buildClassroomAttention', () => {
  it('scopes ungraded and held-grade counts to their own classroom', () => {
    const result = buildClassroomAttention(
      todo({
        coursework: [
          work({ courseworkId: 'a', classroomId: 'c1', stats: stats({ turnedIn: 3 }) }),
          work({ courseworkId: 'b', classroomId: 'c2', stats: stats({ gradedNotReturned: 2 }) }),
        ],
      }),
    )
    expect(attentionFor(result, 'c1')).toEqual({ ungraded: 3, heldGrades: 0, missing: 0, pendingEnrollments: 0, total: 3 })
    expect(attentionFor(result, 'c2')).toEqual({ ungraded: 0, heldGrades: 2, missing: 0, pendingEnrollments: 0, total: 2 })
  })

  it('ignores non-published items and items with nothing to report', () => {
    const result = buildClassroomAttention(
      todo({
        coursework: [
          work({ courseworkId: 'draft', status: 'draft', stats: null }),
          work({ courseworkId: 'zero', stats: stats() }),
        ],
      }),
    )
    expect(attentionFor(result, 'c1').total).toBe(0)
  })

  it('adds missing-work and pending-enrollment counts per classroom', () => {
    const result = buildClassroomAttention(
      todo({
        missingWork: {
          totalMissing: 4,
          items: [
            { classroomId: 'c1', classroomName: 'Class 1', courseworkId: 'a', title: 'A', dueAt: '2026-01-01T00:00:00Z', missingCount: 4, missingStudents: [] },
          ],
        },
        pendingEnrollments: [{ classroomId: 'c2', classroomName: 'Class 2', count: 5 }],
      }),
    )
    expect(attentionFor(result, 'c1')).toEqual({ ungraded: 0, heldGrades: 0, missing: 4, pendingEnrollments: 0, total: 4 })
    expect(attentionFor(result, 'c2')).toEqual({ ungraded: 0, heldGrades: 0, missing: 0, pendingEnrollments: 5, total: 5 })
  })

  it('sums all four signals for one classroom into total', () => {
    const result = buildClassroomAttention(
      todo({
        coursework: [
          work({ courseworkId: 'a', classroomId: 'c1', stats: stats({ turnedIn: 1, gradedNotReturned: 1 }) }),
        ],
        missingWork: {
          totalMissing: 1,
          items: [{ classroomId: 'c1', classroomName: 'Class 1', courseworkId: 'b', title: 'B', dueAt: '2026-01-01T00:00:00Z', missingCount: 1, missingStudents: [] }],
        },
        pendingEnrollments: [{ classroomId: 'c1', classroomName: 'Class 1', count: 1 }],
      }),
    )
    expect(attentionFor(result, 'c1').total).toBe(4)
  })

  it('returns the empty shape for a classroom with no entry, not undefined', () => {
    const result = buildClassroomAttention(todo())
    expect(attentionFor(result, 'unknown')).toEqual({ ungraded: 0, heldGrades: 0, missing: 0, pendingEnrollments: 0, total: 0 })
  })

  it('handles a null todo (not yet loaded) as empty', () => {
    expect(buildClassroomAttention(null).size).toBe(0)
  })
})
