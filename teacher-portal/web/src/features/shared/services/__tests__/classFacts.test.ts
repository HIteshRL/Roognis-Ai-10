import { describe, expect, it } from 'vitest'
import { buildClassFacts, factsWindowLabel } from '../classFacts'
import { NOW, coursework, daysAgo, gradebookFor, snapshot, student, submission } from './fixtures'

/**
 * These cover the gradebook path specifically. It is the only complete record
 * of non-submission across a class — `gradebook.py` emits a cell for every
 * student × task with the synthetic status `"missing"` — and it is the sole
 * grade source for the lite loader the AI Inbox uses, so a mismatch here shows
 * up as an inbox that silently finds nothing.
 */
describe('gradebook-derived facts', () => {
  const students = [student('s1', 'Aarav Shah'), student('s2', 'Ishita Roy')]
  const works = [
    coursework({ id: 'cw-1', dueAt: daysAgo(3) }),
    coursework({ id: 'cw-2', dueAt: daysAgo(9) }),
    coursework({ id: 'cw-3', dueAt: daysAgo(15) }),
  ]

  const facts = () =>
    buildClassFacts(
      snapshot({
        students,
        coursework: works,
        submissions: [],
        detailedCourseworkIds: [],
        gradebook: gradebookFor(students, works, {
          s1: { 'cw-1': 88, 'cw-2': 91, 'cw-3': 85 },
          // Ishita only ever did the oldest task.
          s2: { 'cw-3': 74 },
        }),
      }),
      NOW,
    )

  it('reads scores from gradebook cells', () => {
    const aarav = facts().students.find((entry) => entry.student.studentId === 's1')
    expect(aarav?.gradedCount).toBe(3)
    expect(aarav?.averagePercent).toBeCloseTo(88, 0)
  })

  it('treats a "missing" cell as positive evidence of non-submission', () => {
    const ishita = facts().students.find((entry) => entry.student.studentId === 's2')
    expect(ishita?.missingCount).toBe(2)
    expect(ishita?.gradedCount).toBe(1)
  })

  it('does not mark a submitted task as missing', () => {
    const aarav = facts().students.find((entry) => entry.student.studentId === 's1')
    expect(aarav?.missingCount).toBe(0)
  })

  it('computes task averages without any submission detail', () => {
    const task = facts().tasks.find((entry) => entry.coursework.id === 'cw-3')
    expect(task?.averagePercent).toBeCloseTo(79.5, 1)
    expect(task?.gradedCount).toBe(2)
  })

  it('labels a zero-width window as class-level rather than "0 tasks"', () => {
    expect(factsWindowLabel(facts())).toMatch(/Class-level figures across 3 published tasks/)
  })
})

describe('submission-status buckets', () => {
  const students = [student('s1', 'Aarav Shah')]
  const work = coursework({
    id: 'cw-1',
    dueAt: daysAgo(3),
    submissionStats: { assignedCount: 4, turnedIn: 3, graded: 1, gradedNotReturned: 0, missing: 0 },
  })

  it('reads submitted as turnedIn + returned, not turnedIn alone', () => {
    const facts = buildClassFacts(
      snapshot({ students, coursework: [work], submissions: [] }),
      NOW,
    )
    expect(facts.tasks[0]?.submittedCount).toBe(4)
    expect(facts.tasks[0]?.awaitingFeedbackCount).toBe(3)
    expect(facts.tasks[0]?.returnedCount).toBe(1)
    expect(facts.tasks[0]?.completionRate).toBe(100)
  })

  it('uses the roster as the denominator when stats undercount it', () => {
    // Four submission rows exist, but seven students are enrolled: three never
    // opened the task and so have no row for `submission_stats` to count.
    const roster = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id, index) =>
      student(id, `Student ${index + 1}`),
    )
    const partial = coursework({
      id: 'cw-partial',
      dueAt: daysAgo(3),
      submissionStats: { assignedCount: 4, turnedIn: 0, graded: 4, gradedNotReturned: 0, missing: 0 },
    })
    const facts = buildClassFacts(
      snapshot({ students: roster, coursework: [partial], submissions: [] }),
      NOW,
    )
    expect(facts.tasks[0]?.assignedCount).toBe(7)
    expect(facts.tasks[0]?.submittedCount).toBe(4)
    expect(facts.tasks[0]?.completionRate).toBeCloseTo(57.1, 1)
  })

  it('falls back to submission records when stats are absent', () => {
    const bare = coursework({ id: 'cw-2', dueAt: daysAgo(3) })
    const facts = buildClassFacts(
      snapshot({
        students,
        coursework: [bare],
        submissions: [
          submission({ id: 'sub-1', courseworkId: 'cw-2', studentId: 's1', status: 'returned', grade: 80 }),
        ],
      }),
      NOW,
    )
    expect(facts.tasks[0]?.returnedCount).toBe(1)
    expect(facts.tasks[0]?.awaitingFeedbackCount).toBe(0)
    expect(facts.tasks[0]?.submittedCount).toBe(1)
  })
})

describe('lateness', () => {
  it('counts a submission after the due date as late, not missing', () => {
    const students = [student('s1', 'Mira Nair')]
    const work = coursework({ id: 'cw-1', dueAt: daysAgo(5) })
    const facts = buildClassFacts(
      snapshot({
        students,
        coursework: [work],
        submissions: [
          submission({
            id: 'sub-1',
            courseworkId: 'cw-1',
            studentId: 's1',
            grade: 78,
            turnedInAt: daysAgo(4),
          }),
        ],
      }),
      NOW,
    )
    const mira = facts.students[0]
    expect(mira?.lateCount).toBe(1)
    expect(mira?.missingCount).toBe(0)
  })
})
