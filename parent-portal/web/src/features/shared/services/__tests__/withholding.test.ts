import { describe, expect, it } from 'vitest'
import { canRevealGrade, isGradedNotReturned } from '../withholding'
import type { SubmissionStatus } from '../../types/lms'

const ALL_STATUSES: readonly SubmissionStatus[] = ['draft', 'assigned', 'turned_in', 'returned']

describe('canRevealGrade', () => {
  it('is true for every status when forStudent is false (a teacher may always see it)', () => {
    for (const status of ALL_STATUSES) {
      expect(canRevealGrade(status, false)).toBe(true)
    }
  })

  it('is true for a student only when the submission is returned', () => {
    for (const status of ALL_STATUSES) {
      expect(canRevealGrade(status, true)).toBe(status === 'returned')
    }
  })

  // Exhaustive: all 4 SubmissionStatus values × forStudent, matching the
  // plan's own coverage requirement — this is the exact matrix
  // serialize_submission's `withhold` boolean is evaluated over server-side.
  it.each(ALL_STATUSES)('status=%s, forStudent=true', (status) => {
    expect(canRevealGrade(status, true)).toBe(status === 'returned')
  })

  it.each(ALL_STATUSES)('status=%s, forStudent=false', (status) => {
    expect(canRevealGrade(status, false)).toBe(true)
  })
})

describe('isGradedNotReturned', () => {
  it.each(ALL_STATUSES)('status=%s with a grade present', (status) => {
    expect(isGradedNotReturned(status, 8)).toBe(status !== 'returned')
  })

  it.each(ALL_STATUSES)('status=%s with no grade', (status) => {
    // No grade at all is never "graded but not returned" — grade is null,
    // regardless of status.
    expect(isGradedNotReturned(status, null)).toBe(false)
  })

  it('is true for a zero grade (falsy but not null/undefined)', () => {
    // Regression guard: an earlier draft of this check could plausibly have
    // used `!grade` instead of `grade != null`, which would wrongly treat a
    // 0 grade as "no grade".
    expect(isGradedNotReturned('turned_in', 0)).toBe(true)
  })
})
