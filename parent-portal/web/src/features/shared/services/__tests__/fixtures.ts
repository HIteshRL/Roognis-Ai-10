/**
 * Fixture builders for the deterministic rulesets.
 *
 * Tests construct `ClassSnapshot` payloads shaped exactly like the LMS
 * serializers and run them through the real `buildClassFacts`, so a change to
 * either the wire contract or the derivation is caught here rather than in a
 * browser.
 */

import type { StudentRef } from '../../types/common'
import type { Classroom, Coursework, Gradebook, Submission } from '../../types/lms'
import type { ClassSnapshot } from '../classFacts'

export const NOW = new Date('2026-07-29T09:00:00.000Z').getTime()
const DAY = 86_400_000

export const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString()
export const daysAhead = (days: number): string => new Date(NOW + days * DAY).toISOString()

export const classroom = (overrides: Partial<Classroom> = {}): Classroom => ({
  id: 'class-1',
  name: 'Grade 8 Science',
  subject: 'Science',
  section: 'A',
  grade: '8',
  color: '#4f46e5',
  studentCount: 6,
  ...overrides,
})

export const student = (id: string, name: string): StudentRef => ({
  studentId: id,
  name,
  classroomId: 'class-1',
  classroomName: 'Grade 8 Science',
})

export const coursework = (overrides: Partial<Coursework> & { id: string }): Coursework => ({
  classroomId: 'class-1',
  chapterId: null,
  type: 'assignment',
  title: `Task ${overrides.id}`,
  description: null,
  topic: null,
  topicId: null,
  maxPoints: 100,
  dueAt: daysAgo(5),
  status: 'published',
  scheduledFor: null,
  publishedAt: daysAgo(12),
  allowResubmission: true,
  attachments: [],
  rubricCriteria: null,
  createdAt: daysAgo(12),
  updatedAt: daysAgo(12),
  ...overrides,
})

export const submission = (
  overrides: Partial<Submission> & { id: string; courseworkId: string; studentId: string },
): Submission => ({
  studentName: null,
  status: 'returned',
  isLate: false,
  content: {},
  grade: null,
  feedback: null,
  rubricScores: null,
  turnedInAt: daysAgo(6),
  gradedAt: daysAgo(4),
  createdAt: daysAgo(10),
  updatedAt: daysAgo(4),
  ...overrides,
})

/**
 * A gradebook shaped exactly like `gradebook.py::build_gradebook`: a cell for
 * every student × published-gradeable task, using the synthetic status
 * `"missing"` where no submission exists.
 *
 * `scores` maps studentId → courseworkId → score, where an absent entry means
 * the student never submitted.
 */
export function gradebookFor(
  students: readonly StudentRef[],
  works: readonly Coursework[],
  scores: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Gradebook {
  const columns = works.map((work) => ({
    courseworkId: work.id,
    title: work.title,
    type: work.type,
    maxPoints: work.maxPoints,
    dueAt: work.dueAt,
  }))

  const rows = students.map((entry) => {
    const studentScores = scores[entry.studentId] ?? {}
    const cells: Record<string, { status: 'returned' | 'missing'; score: number | null; returned: boolean }> = {}
    let earned = 0
    let possible = 0

    for (const work of works) {
      const score = studentScores[work.id]
      if (score === undefined) {
        cells[work.id] = { status: 'missing', score: null, returned: false }
        continue
      }
      cells[work.id] = { status: 'returned', score, returned: true }
      earned += score
      possible += work.maxPoints ?? 0
    }

    return {
      studentId: entry.studentId,
      studentName: entry.name,
      cells,
      averagePercent: possible ? Math.round((earned / possible) * 1000) / 10 : null,
    }
  })

  const averages = rows
    .map((row) => row.averagePercent)
    .filter((value): value is number => value !== null)

  return {
    classroomId: 'class-1',
    columns,
    rows,
    classAveragePercent: averages.length
      ? Math.round((averages.reduce((sum, v) => sum + v, 0) / averages.length) * 10) / 10
      : null,
    studentCount: students.length,
  }
}

export interface SnapshotSpec {
  readonly students: readonly StudentRef[]
  readonly coursework: readonly Coursework[]
  readonly submissions: readonly Submission[]
  /** Defaults to every published gradeable task. */
  readonly detailedCourseworkIds?: readonly string[]
  readonly gradebook?: Gradebook | null
  readonly classroom?: Classroom
}

export function snapshot(spec: SnapshotSpec): ClassSnapshot {
  const byCoursework = new Map<string, Submission[]>()
  for (const entry of spec.submissions) {
    const bucket = byCoursework.get(entry.courseworkId)
    if (bucket) bucket.push(entry)
    else byCoursework.set(entry.courseworkId, [entry])
  }

  return {
    classroom: spec.classroom ?? classroom(),
    students: spec.students,
    coursework: spec.coursework,
    submissionsByCoursework: byCoursework,
    gradebook: spec.gradebook ?? null,
    detailedCourseworkIds:
      spec.detailedCourseworkIds ??
      spec.coursework.filter((work) => work.status === 'published').map((work) => work.id),
  }
}

/**
 * Build a run of graded tasks for one student. `percents` is newest-first, so
 * `[30, 30, 90, 90]` reads as "was strong, has fallen".
 */
export function gradedRun(
  studentId: string,
  percents: readonly number[],
  options: { readonly lateIndices?: readonly number[]; readonly missingIndices?: readonly number[] } = {},
): { coursework: Coursework[]; submissions: Submission[] } {
  const late = new Set(options.lateIndices ?? [])
  const missing = new Set(options.missingIndices ?? [])
  const works: Coursework[] = []
  const submissions: Submission[] = []

  percents.forEach((percent, index) => {
    const dueAt = daysAgo(3 + index * 4)
    const work = coursework({ id: `cw-${index}`, dueAt, publishedAt: daysAgo(10 + index * 4) })
    works.push(work)
    if (missing.has(index)) return
    submissions.push(
      submission({
        id: `sub-${studentId}-${index}`,
        courseworkId: work.id,
        studentId,
        grade: percent,
        turnedInAt: late.has(index)
          ? new Date(new Date(dueAt).getTime() + DAY).toISOString()
          : new Date(new Date(dueAt).getTime() - DAY).toISOString(),
      }),
    )
  })

  return { coursework: works, submissions }
}
