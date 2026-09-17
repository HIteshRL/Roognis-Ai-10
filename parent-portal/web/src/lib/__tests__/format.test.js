import { describe, expect, it } from 'vitest'
import { parseApiDate } from '../format'

/**
 * The LMS emits `datetime.isoformat()`. Under Postgres the column is
 * timezone-aware and the string carries `+00:00`; under SQLite it is naive and
 * the offset is missing entirely. JavaScript reads an unlabelled date-time as
 * *local* time, so without normalisation the same record renders hours apart
 * depending on the database behind the API — which is exactly what showed up as
 * a due date landing 5.5 hours early.
 */
describe('parseApiDate', () => {
  it('reads an unlabelled timestamp as UTC', () => {
    expect(parseApiDate('2026-08-05T10:30:00')?.toISOString()).toBe('2026-08-05T10:30:00.000Z')
  })

  it('keeps fractional seconds', () => {
    expect(parseApiDate('2026-07-28T14:50:55.724676')?.toISOString()).toBe(
      '2026-07-28T14:50:55.724Z',
    )
  })

  it('leaves an explicit Z alone', () => {
    expect(parseApiDate('2026-08-05T10:30:00Z')?.toISOString()).toBe('2026-08-05T10:30:00.000Z')
  })

  it('honours an explicit offset rather than overriding it', () => {
    expect(parseApiDate('2026-08-05T16:00:00+05:30')?.toISOString()).toBe(
      '2026-08-05T10:30:00.000Z',
    )
  })

  it('honours a compact offset', () => {
    expect(parseApiDate('2026-08-05T16:00:00+0530')?.toISOString()).toBe('2026-08-05T10:30:00.000Z')
  })

  it('leaves a date-only string to the platform’s UTC-midnight rule', () => {
    expect(parseApiDate('2026-08-05')?.toISOString()).toBe('2026-08-05T00:00:00.000Z')
  })

  it('returns null for empty or unparseable input', () => {
    expect(parseApiDate(null)).toBeNull()
    expect(parseApiDate(undefined)).toBeNull()
    expect(parseApiDate('')).toBeNull()
    expect(parseApiDate('not a date')).toBeNull()
  })
})
