import { useCallback, useMemo, useState } from 'react'
import { type UseQueryResult, useQuery } from '../../shared/hooks/useQuery'
import { getCalendar } from '../../shared/services/lmsService'
import type { CalendarResponse } from '../../shared/types/lms'

export interface CalendarRange {
  readonly start: Date
  readonly end: Date
  readonly label: string
}

const monthRange = (offset: number): CalendarRange => {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  start.setMonth(start.getMonth() + offset)

  const end = new Date(start)
  end.setMonth(end.getMonth() + 1)
  end.setDate(0)
  end.setHours(23, 59, 59, 999)

  return {
    start,
    end,
    label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  }
}

export interface UseCalendarRangeResult {
  readonly range: CalendarRange
  readonly query: UseQueryResult<CalendarResponse>
  readonly next: () => void
  readonly previous: () => void
  readonly today: () => void
  readonly isCurrentMonth: boolean
  /** Months from the current month; 0 is this month. Exposed so a paged
   * child (CalendarMini) can stay in sync with this hook's own month rather
   * than keeping a second, independent offset. */
  readonly offset: number
  readonly goToOffset: (offset: number) => void
}

/**
 * One month of the LMS calendar at a time.
 *
 * `GET /api/lms/calendar` takes an explicit `[start, end]`, so the month is the
 * query key — moving month refetches rather than filtering a preloaded year.
 */
export function useCalendarRange(): UseCalendarRangeResult {
  const [offset, setOffset] = useState(0)
  const range = useMemo(() => monthRange(offset), [offset])

  const query = useQuery<CalendarResponse>(
    ['lms', 'calendar', range.start.toISOString()],
    () => getCalendar({ start: range.start.toISOString(), end: range.end.toISOString() }),
    { staleTime: 120_000 },
  )

  return {
    range,
    query,
    next: useCallback(() => setOffset((current) => current + 1), []),
    previous: useCallback(() => setOffset((current) => current - 1), []),
    today: useCallback(() => setOffset(0), []),
    isCurrentMonth: offset === 0,
    offset,
    goToOffset: setOffset,
  }
}
