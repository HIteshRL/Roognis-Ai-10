import { describe, expect, it } from 'vitest'
import { submission } from '../../../shared/services/__tests__/fixtures'
import type { RubricCriterion, Submission } from '../../../shared/types/lms'
import {
  applyGradedOptimistically,
  bulkSelectable,
  mergedRubricScores,
  nextIndex,
  orderForGrading,
  queueCounts,
  rubricTotal,
  toBulkPayload,
  validateGrade,
} from '../gradingQueue'

const sub = (overrides: Partial<Submission> & { id: string }) =>
  submission({ courseworkId: 'cw-1', studentId: 's1', ...overrides })

describe('orderForGrading', () => {
  it('puts ungraded submissions before graded ones, stable within each group', () => {
    const graded = sub({ id: 'a', grade: 9, status: 'returned' })
    const ungraded1 = sub({ id: 'b', grade: null, status: 'turned_in' })
    const ungraded2 = sub({ id: 'c', grade: null, status: 'turned_in' })

    const ordered = orderForGrading([graded, ungraded1, ungraded2])
    expect(ordered.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('bulkSelectable', () => {
  it('excludes draft submissions', () => {
    const draft = sub({ id: 'd', status: 'draft', grade: null })
    const turnedIn = sub({ id: 't', status: 'turned_in', grade: null })
    expect(bulkSelectable([draft, turnedIn]).map((s) => s.id)).toEqual(['t'])
  })
})

describe('validateGrade', () => {
  it('rejects a non-finite value', () => {
    expect(validateGrade(NaN, 10).valid).toBe(false)
  })

  it('rejects a negative value', () => {
    expect(validateGrade(-1, 10).valid).toBe(false)
  })

  it('rejects a value over maxPoints', () => {
    const result = validateGrade(15, 10)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('10')
  })

  it('accepts a value within bounds', () => {
    expect(validateGrade(8, 10)).toEqual({ valid: true })
  })

  it('accepts any non-negative value when maxPoints is null', () => {
    expect(validateGrade(1000, null).valid).toBe(true)
  })
})

describe('mergedRubricScores / rubricTotal', () => {
  const criteria: readonly RubricCriterion[] = [
    { criterion: 'Structure', maxPoints: 5 },
    { criterion: 'Evidence', maxPoints: 5 },
  ]

  it('merges the submission’s existing rubric scores with the draft’s overrides', () => {
    const submissionWithScores = sub({
      id: 's',
      rubricScores: [{ criterion: 'Structure', points: 4 }],
    })
    const merged = mergedRubricScores(submissionWithScores, { scores: { Evidence: '3' } })
    expect(merged).toEqual({ Structure: '4', Evidence: '3' })
    expect(rubricTotal(criteria, merged)).toBe(7)
  })

  it('lets a draft override an existing score', () => {
    const submissionWithScores = sub({
      id: 's',
      rubricScores: [{ criterion: 'Structure', points: 4 }],
    })
    const merged = mergedRubricScores(submissionWithScores, { scores: { Structure: '2' } })
    expect(merged.Structure).toBe('2')
  })

  it('treats a missing draft as no override', () => {
    const submissionWithScores = sub({ id: 's', rubricScores: [{ criterion: 'Structure', points: 4 }] })
    expect(mergedRubricScores(submissionWithScores, undefined)).toEqual({ Structure: '4' })
  })
})

describe('toBulkPayload', () => {
  it('includes only submissions with an entered draft grade', () => {
    const untouched = sub({ id: 'a', status: 'turned_in', grade: null })
    const touched = sub({ id: 'b', status: 'turned_in', grade: null })
    const result = toBulkPayload([untouched, touched], { b: { grade: '8' } }, 10)
    expect(result.errors).toEqual([])
    expect(result.items).toEqual([{ submissionId: 'b', grade: 8, feedback: undefined }])
  })

  it('excludes drafts even if a stray draft entry targets one', () => {
    const draftStatus = sub({ id: 'd', status: 'draft', grade: null })
    const result = toBulkPayload([draftStatus], { d: { grade: '5' } }, 10)
    expect(result.items).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('aborts the whole batch — zero items — when any entered grade is invalid', () => {
    const good = sub({ id: 'a', status: 'turned_in', grade: null })
    const bad = sub({ id: 'b', status: 'turned_in', grade: null })
    const result = toBulkPayload(
      [good, bad],
      { a: { grade: '8' }, b: { grade: '999' } },
      10,
    )
    expect(result.items).toEqual([])
    expect(result.errors).toEqual([{ submissionId: 'b', error: 'Grade cannot exceed 10.' }])
  })

  it('falls back to the submission’s existing feedback when the draft has none', () => {
    const existing = sub({ id: 'a', status: 'turned_in', grade: null, feedback: 'Nice work' })
    const result = toBulkPayload([existing], { a: { grade: '8' } }, 10)
    expect(result.items).toEqual([{ submissionId: 'a', grade: 8, feedback: 'Nice work' }])
  })
})

describe('applyGradedOptimistically', () => {
  it('increments graded, not gradedNotReturned, when a submission comes back returned', () => {
    const before = sub({ id: 'a', status: 'turned_in', grade: null })
    const after = sub({ id: 'a', status: 'returned', grade: 9 })
    const previous = {
      courseworkId: 'cw-1',
      stats: { assignedCount: 1, turnedIn: 1, graded: 0, gradedNotReturned: 0, missing: 0 },
      submissions: [before],
    }
    const next = applyGradedOptimistically(previous, [after])
    expect(next.stats.graded).toBe(1)
    expect(next.stats.gradedNotReturned).toBe(0)
    expect(next.stats.turnedIn).toBe(0)
  })

  it('increments gradedNotReturned, not graded, when a grade is saved but withheld (Trap A)', () => {
    const before = sub({ id: 'a', status: 'turned_in', grade: null })
    const after = sub({ id: 'a', status: 'turned_in', grade: 9 })
    const previous = {
      courseworkId: 'cw-1',
      stats: { assignedCount: 1, turnedIn: 1, graded: 0, gradedNotReturned: 0, missing: 0 },
      submissions: [before],
    }
    const next = applyGradedOptimistically(previous, [after])
    expect(next.stats.graded).toBe(0)
    expect(next.stats.gradedNotReturned).toBe(1)
    expect(next.stats.turnedIn).toBe(1)
  })

  it('leaves assignedCount untouched and recomputes missing from the merged list', () => {
    const before = sub({ id: 'a', status: 'turned_in', grade: null })
    const after = sub({ id: 'a', status: 'returned', grade: 9 })
    const previous = {
      courseworkId: 'cw-1',
      stats: { assignedCount: 3, turnedIn: 1, graded: 0, gradedNotReturned: 0, missing: 2 },
      submissions: [before],
    }
    const next = applyGradedOptimistically(previous, [after])
    expect(next.stats.assignedCount).toBe(3)
    expect(next.stats.missing).toBe(2)
  })

  it('leaves an unrelated submission (not in the graded batch) untouched', () => {
    const graded = sub({ id: 'a', status: 'turned_in', grade: null })
    const other = sub({ id: 'b', status: 'turned_in', grade: null })
    const previous = {
      courseworkId: 'cw-1',
      stats: { assignedCount: 2, turnedIn: 2, graded: 0, gradedNotReturned: 0, missing: 0 },
      submissions: [graded, other],
    }
    const next = applyGradedOptimistically(previous, [sub({ id: 'a', status: 'returned', grade: 9 })])
    expect(next.submissions.find((s) => s.id === 'b')).toBe(other)
  })
})

describe('queueCounts', () => {
  it('buckets submissions by status, using isGradedNotReturned for the withheld bucket', () => {
    const returned = sub({ id: 'a', status: 'returned', grade: 9 })
    const withheld = sub({ id: 'b', status: 'turned_in', grade: 7 })
    const ungraded = sub({ id: 'c', status: 'turned_in', grade: null })
    const draft = sub({ id: 'd', status: 'draft', grade: null })

    const counts = queueCounts([returned, withheld, ungraded, draft])
    expect(counts).toEqual({ total: 4, ungraded: 1, gradedNotReturned: 1, returned: 1, draft: 1 })
  })
})

describe('nextIndex', () => {
  it('wraps forward past the last index', () => {
    expect(nextIndex(2, 3, 1)).toBe(0)
  })

  it('wraps backward past the first index', () => {
    expect(nextIndex(0, 3, -1)).toBe(2)
  })

  it('clamps at the last index when wrap is false', () => {
    expect(nextIndex(2, 3, 1, false)).toBe(2)
  })

  it('clamps at the first index when wrap is false', () => {
    expect(nextIndex(0, 3, -1, false)).toBe(0)
  })

  it('returns 0 for an empty list', () => {
    expect(nextIndex(0, 0, 1)).toBe(0)
  })
})
