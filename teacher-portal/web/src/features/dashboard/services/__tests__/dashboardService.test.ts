import { describe, expect, it } from 'vitest'
import type {
  TeacherTodoCourseworkEntry,
  TeacherTodoResponse,
  TeacherTodoStats,
} from '../../../shared/types/lms'
import { buildPendingReviews } from '../dashboardService'

const stats = (overrides: Partial<TeacherTodoStats> = {}): TeacherTodoStats => ({
  assignedCount: 10,
  turnedIn: 0,
  graded: 0,
  gradedNotReturned: 0,
  missing: 0,
  ...overrides,
})

const work = (overrides: Partial<TeacherTodoCourseworkEntry> & { courseworkId: string }): TeacherTodoCourseworkEntry => ({
  classroomId: 'class-1',
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

const args = (t: TeacherTodoResponse) => ({
  classrooms: [],
  todo: t,
  notifications: [],
  focusedFacts: null,
})

describe('buildPendingReviews — ungraded work (regression: TeacherTodoCourseworkEntry shape)', () => {
  it('sums turnedIn across classrooms and names the biggest queue', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'a', classroomId: 'c1', classroomName: 'Class A', stats: stats({ turnedIn: 3 }) }),
            work({ courseworkId: 'b', classroomId: 'c2', classroomName: 'Class B', stats: stats({ turnedIn: 7 }) }),
          ],
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'assignment-grading')
    expect(row?.count).toBe(10)
    expect(row?.detail).toContain('Task b')
    expect(row?.classroomId).toBe('c2')
  })

  it('splits quizzes into their own row, separate from assignments', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'a', type: 'assignment', stats: stats({ turnedIn: 2 }) }),
            work({ courseworkId: 'q', type: 'quiz', stats: stats({ turnedIn: 4 }) }),
          ],
        }),
      ),
    )
    expect(summary.items.find((i) => i.kind === 'assignment-grading')?.count).toBe(2)
    expect(summary.items.find((i) => i.kind === 'quiz-review')?.count).toBe(4)
  })

  it('ignores non-published items and items with nothing turned in', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'draft', status: 'draft', stats: null }),
            work({ courseworkId: 'zero', stats: stats({ turnedIn: 0 }) }),
          ],
        }),
      ),
    )
    expect(summary.items.find((i) => i.kind === 'assignment-grading')).toBeUndefined()
  })
})

describe('buildPendingReviews — held grades (Trap A: gradedNotReturned)', () => {
  it('sums gradedNotReturned across classrooms and names the biggest backlog', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'a', classroomId: 'c1', classroomName: 'Class A', stats: stats({ gradedNotReturned: 2 }) }),
            work({ courseworkId: 'b', classroomId: 'c2', classroomName: 'Class B', stats: stats({ gradedNotReturned: 9 }) }),
          ],
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'held-grades')
    expect(row?.count).toBe(11)
    expect(row?.detail).toContain('Task b')
    expect(row?.classroomId).toBe('c2')
  })

  it('is absent when nothing is held', () => {
    const summary = buildPendingReviews(args(todo({ coursework: [work({ courseworkId: 'a' })] })))
    expect(summary.items.find((i) => i.kind === 'held-grades')).toBeUndefined()
  })

  it('does not double-count a submission that is both turned-in-ungraded and held elsewhere', () => {
    // One row is genuinely both: turnedIn counts submissions not yet returned
    // regardless of whether they're graded, gradedNotReturned counts only the
    // graded-but-withheld subset. A row with grade set should still show up in
    // both — they are two different questions ("needs a first grade" vs
    // "already graded, not returned"), not a double-count of one number.
    const summary = buildPendingReviews(
      args(todo({ coursework: [work({ courseworkId: 'a', stats: stats({ turnedIn: 1, gradedNotReturned: 1 }) })] })),
    )
    expect(summary.items.find((i) => i.kind === 'assignment-grading')?.count).toBe(1)
    expect(summary.items.find((i) => i.kind === 'held-grades')?.count).toBe(1)
  })
})

describe('buildPendingReviews — missing work', () => {
  it('passes through totalMissing and names the item with the most missing students', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          missingWork: {
            totalMissing: 5,
            items: [
              { classroomId: 'c1', classroomName: 'Class A', courseworkId: 'a', title: 'Small gap', dueAt: '2026-01-01T00:00:00Z', missingCount: 1, missingStudents: [] },
              { classroomId: 'c2', classroomName: 'Class B', courseworkId: 'b', title: 'Big gap', dueAt: '2026-01-02T00:00:00Z', missingCount: 4, missingStudents: [] },
            ],
          },
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'missing-work')
    expect(row?.count).toBe(5)
    expect(row?.detail).toContain('Big gap')
    expect(row?.classroomId).toBe('c2')
  })

  it('is absent when nothing is missing', () => {
    const summary = buildPendingReviews(args(todo()))
    expect(summary.items.find((i) => i.kind === 'missing-work')).toBeUndefined()
  })
})

describe('buildPendingReviews — pending enrollments', () => {
  it('sums counts across classrooms and names the classroom with the most', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          pendingEnrollments: [
            { classroomId: 'c1', classroomName: 'Class A', count: 1 },
            { classroomId: 'c2', classroomName: 'Class B', count: 3 },
          ],
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'pending-enrollment')
    expect(row?.count).toBe(4)
    expect(row?.classroomId).toBe('c2')
  })
})

describe('buildPendingReviews — drafts and scheduled items', () => {
  it('names the oldest draft, not the newest', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'new', status: 'draft', createdAt: '2026-03-01T00:00:00Z', stats: null }),
            work({ courseworkId: 'old', status: 'draft', createdAt: '2026-01-01T00:00:00Z', stats: null }),
          ],
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'draft-unpublished')
    expect(row?.count).toBe(2)
    expect(row?.detail).toContain('Task old')
  })

  it('names the soonest scheduled item, not the furthest out', () => {
    const summary = buildPendingReviews(
      args(
        todo({
          coursework: [
            work({ courseworkId: 'later', status: 'scheduled', scheduledFor: '2026-06-01T00:00:00Z', stats: null }),
            work({ courseworkId: 'soon', status: 'scheduled', scheduledFor: '2026-02-01T00:00:00Z', stats: null }),
          ],
        }),
      ),
    )
    const row = summary.items.find((i) => i.kind === 'scheduled-soon')
    expect(row?.count).toBe(2)
    expect(row?.detail).toContain('Task soon')
  })
})
