import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useClassFacts } from '../../shared/hooks/useClassFacts'
import { useClassrooms } from '../../shared/hooks/useClassrooms'
import { usePreferences } from '../../shared/hooks/usePreferences'
import { COLLECTIONS } from '../../shared/services/preferenceStore'
import type { Classroom } from '../../shared/types/lms'
import { buildInterventionQueue } from '../services/riskRules'
import type { InterventionQueue, RiskCategory, StudentRisk } from '../types/intervention'

export interface UseInterventionsResult {
  readonly queue: InterventionQueue | null
  readonly classrooms: readonly Classroom[]
  readonly classroom: Classroom | null
  readonly setClassroomId: (id: string) => void
  readonly factsQuery: ReturnType<typeof useClassFacts>

  readonly categoryFilter: RiskCategory | 'all'
  readonly setCategoryFilter: (value: RiskCategory | 'all') => void
  readonly search: string
  readonly setSearch: (value: string) => void

  /** Risk the URL asked for (`?student=…`), if it is in the queue. */
  readonly linkedRisk: StudentRisk | null
  readonly isResolved: (riskId: string) => boolean
  readonly toggleResolved: (risk: StudentRisk) => void
  readonly visibleGroups: InterventionQueue['groups']
  readonly refetch: () => void
}

/**
 * The intervention queue for one class.
 *
 * Scoped to a single class by design, not by omission: the queue needs
 * per-student submission records, and fanning that across every class a teacher
 * owns would be dozens of requests for a screen they read one class at a time.
 * The class is explicit in the UI and in the URL.
 */
export function useInterventions(): UseInterventionsResult {
  const classroomsQuery = useClassrooms()
  const preferences = usePreferences()
  const [searchParams, setSearchParams] = useSearchParams()
  const [categoryFilter, setCategoryFilter] = useState<RiskCategory | 'all'>('all')
  const [search, setSearch] = useState('')

  const classrooms = useMemo(() => classroomsQuery.data ?? [], [classroomsQuery.data])
  const requestedClassId = searchParams.get('class')
  const classroom = useMemo(
    () => classrooms.find((entry) => entry.id === requestedClassId) ?? classrooms[0] ?? null,
    [classrooms, requestedClassId],
  )

  const factsQuery = useClassFacts(classroom)
  const queue = useMemo(
    () => (factsQuery.data ? buildInterventionQueue(factsQuery.data) : null),
    [factsQuery.data],
  )

  const setClassroomId = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams)
      next.set('class', id)
      next.delete('student')
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const linkedStudentId = searchParams.get('student')
  const linkedRisk = useMemo(
    () => queue?.all.find((risk) => risk.student.studentId === linkedStudentId) ?? null,
    [queue, linkedStudentId],
  )

  const resolvedIds = useMemo(
    () => new Set(preferences.list(COLLECTIONS.resolvedInterventions)),
    [preferences],
  )

  const visibleGroups = useMemo(() => {
    if (!queue) return []
    const needle = search.trim().toLowerCase()
    return queue.groups
      .filter((group) => categoryFilter === 'all' || group.spec.id === categoryFilter)
      .map((group) => ({
        ...group,
        risks: group.risks.filter(
          (risk) => !needle || risk.student.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.risks.length > 0)
  }, [queue, categoryFilter, search])

  return {
    queue,
    classrooms,
    classroom,
    setClassroomId,
    factsQuery,
    categoryFilter,
    setCategoryFilter,
    search,
    setSearch,
    linkedRisk,
    isResolved: useCallback((riskId: string) => resolvedIds.has(riskId), [resolvedIds]),
    toggleResolved: useCallback(
      (risk: StudentRisk) => {
        preferences.toggle(COLLECTIONS.resolvedInterventions, risk.id)
      },
      [preferences],
    ),
    visibleGroups,
    refetch: useCallback(() => void factsQuery.refetch(), [factsQuery]),
  }
}
