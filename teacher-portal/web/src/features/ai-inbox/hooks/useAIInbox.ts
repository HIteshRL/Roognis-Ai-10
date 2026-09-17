import { useCallback, useMemo, useState } from 'react'
import { useClassrooms } from '../../shared/hooks/useClassrooms'
import { usePreferences } from '../../shared/hooks/usePreferences'
import { type UseQueryResult, useQuery } from '../../shared/hooks/useQuery'
import { type ClassFacts, loadClassFactsLite } from '../../shared/services/classFacts'
import { COLLECTIONS } from '../../shared/services/preferenceStore'
import type { Classroom } from '../../shared/types/lms'
import { buildInsights } from '../services/insightRules'
import { type InsightStatusMap, buildInbox, statusOf } from '../services/insightService'
import type { AIInboxState, AIInsight, InsightStatus } from '../types/insight'

export interface UseAIInboxResult {
  readonly inbox: AIInboxState | null
  readonly insights: readonly AIInsight[]
  readonly classrooms: readonly Classroom[]
  readonly factsQuery: UseQueryResult<readonly ClassFacts[]>

  readonly classroomFilter: string | 'all'
  readonly setClassroomFilter: (value: string | 'all') => void
  readonly showResolved: boolean
  readonly setShowResolved: (value: boolean) => void

  readonly statusOf: (insightId: string) => InsightStatus
  readonly accept: (insight: AIInsight) => void
  readonly dismiss: (insight: AIInsight) => void
  readonly restore: (insight: AIInsight) => void
  readonly resolvedCount: number
  readonly refetch: () => void
}

/**
 * The AI Inbox across every class the teacher owns.
 *
 * Uses the lite facts loader — two requests per class — because every insight
 * the inbox produces is class-level. The intervention queue, which needs
 * per-student records, deliberately stays scoped to one class rather than
 * making this read twelve times more expensive.
 *
 * Accept and dismiss are local decisions. There is no server-side insight
 * store: insights are recomputed from LMS records on every load, so what
 * persists is only the teacher's judgement about them. When a decision service
 * exists, these become writes and nothing else changes.
 */
export function useAIInbox(): UseAIInboxResult {
  const classroomsQuery = useClassrooms()
  const preferences = usePreferences()
  const [classroomFilter, setClassroomFilter] = useState<string | 'all'>('all')
  const [showResolved, setShowResolved] = useState(false)

  const classrooms = useMemo(() => classroomsQuery.data ?? [], [classroomsQuery.data])
  const classroomIds = useMemo(() => classrooms.map((entry) => entry.id).join(','), [classrooms])

  const factsQuery = useQuery<readonly ClassFacts[]>(
    ['facts', 'lite-all', classroomIds],
    async () => {
      const results = await Promise.all(
        classrooms.map((classroom) =>
          loadClassFactsLite(classroom).catch(() => null),
        ),
      )
      return results.filter((facts): facts is ClassFacts => facts !== null)
    },
    { enabled: classrooms.length > 0, staleTime: 120_000 },
  )

  const insights = useMemo(() => {
    const all = (factsQuery.data ?? []).flatMap((facts) => buildInsights(facts))
    return classroomFilter === 'all'
      ? all
      : all.filter((insight) => insight.classroomId === classroomFilter)
  }, [factsQuery.data, classroomFilter])

  const statuses: InsightStatusMap = useMemo(
    () => ({
      dismissed: new Set(preferences.list(COLLECTIONS.dismissedInsights)),
      accepted: new Set(preferences.list(COLLECTIONS.acceptedInsights)),
    }),
    [preferences],
  )

  const inbox = useMemo(
    () => (factsQuery.data ? buildInbox(insights, statuses, { includeResolved: showResolved }) : null),
    [factsQuery.data, insights, statuses, showResolved],
  )

  const resolvedCount = useMemo(
    () => insights.filter((insight) => statusOf(insight.id, statuses) !== 'open').length,
    [insights, statuses],
  )

  const accept = useCallback(
    (insight: AIInsight) => {
      preferences.remove(COLLECTIONS.dismissedInsights, insight.id)
      preferences.add(COLLECTIONS.acceptedInsights, insight.id)
    },
    [preferences],
  )

  const dismiss = useCallback(
    (insight: AIInsight) => {
      preferences.remove(COLLECTIONS.acceptedInsights, insight.id)
      preferences.add(COLLECTIONS.dismissedInsights, insight.id)
    },
    [preferences],
  )

  const restore = useCallback(
    (insight: AIInsight) => {
      preferences.remove(COLLECTIONS.acceptedInsights, insight.id)
      preferences.remove(COLLECTIONS.dismissedInsights, insight.id)
    },
    [preferences],
  )

  return {
    inbox,
    insights,
    classrooms,
    factsQuery,
    classroomFilter,
    setClassroomFilter,
    showResolved,
    setShowResolved,
    statusOf: useCallback((insightId: string) => statusOf(insightId, statuses), [statuses]),
    accept,
    dismiss,
    restore,
    resolvedCount,
    refetch: useCallback(() => void factsQuery.refetch(), [factsQuery]),
  }
}
