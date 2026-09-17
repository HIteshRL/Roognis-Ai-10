import { useCallback, useMemo, useState } from 'react'
import { buildInsights } from '../../ai-inbox/services/insightRules'
import type { AIInsight } from '../../ai-inbox/types/insight'
import { buildInterventionQueue } from '../../interventions/services/riskRules'
import type { InterventionQueue } from '../../interventions/types/intervention'
import { useClassFacts } from '../../shared/hooks/useClassFacts'
import { useClassrooms } from '../../shared/hooks/useClassrooms'
import { type UseQueryResult, useQuery } from '../../shared/hooks/useQuery'
import { getCalendar, getTeacherTodo, listNotifications } from '../../shared/services/lmsService'
import type { CalendarResponse, Classroom, LmsNotification, TeacherTodoResponse } from '../../shared/types/lms'
import {
  buildDeadlines,
  buildPendingReviews,
  buildTodaySchedule,
} from '../services/dashboardService'
import { buildRecommendations } from '../services/recommendationService'
import type {
  DeadlineGroup,
  PendingReviewSummary,
  Recommendation,
  TodaySchedule,
} from '../types/dashboard'

const DEADLINE_HORIZON_DAYS = 21

export interface TeacherDashboard {
  readonly classrooms: readonly Classroom[]
  /** The class the deep panels (queue, recommendations) are scoped to. */
  readonly focusedClassroom: Classroom | null
  readonly setFocusedClassroomId: (id: string) => void

  readonly schedule: TodaySchedule | null
  readonly pendingReviews: PendingReviewSummary | null
  readonly deadlines: readonly DeadlineGroup[]
  readonly interventions: InterventionQueue | null
  readonly recommendations: readonly Recommendation[]
  readonly recommendationTotal: number
  readonly insights: readonly AIInsight[]

  readonly classroomsQuery: UseQueryResult<readonly Classroom[]>
  readonly todoQuery: UseQueryResult<TeacherTodoResponse>
  readonly calendarQuery: UseQueryResult<CalendarResponse>
  readonly notificationsQuery: UseQueryResult<readonly LmsNotification[]>
  readonly factsQuery: ReturnType<typeof useClassFacts>

  readonly refetchAll: () => void
}

/**
 * Assembles the Command Center.
 *
 * Two scopes on purpose. Cheap, class-count-bounded reads (the teacher to-do,
 * calendar, notifications) cover *all* the teacher's classes, so counts and
 * deadlines are whole-workload figures. The expensive read — the gradebook plus
 * submission detail that the rulesets need — runs for one focused class, and
 * every panel built from it says which class it is describing. Fanning that out
 * across every class would mean dozens of requests before the dashboard paints.
 *
 * Sprint 4, P4 (T4.2): `todoQuery` used to be a `Promise.all` over
 * `listCoursework` — one request per classroom — to build the same
 * `classroomId → Coursework[]` picture `GET /teacher/todo` now returns in a
 * single request. `buildTodaySchedule` and `buildPendingReviews` both read
 * from it.
 */
export function useTeacherDashboard(): TeacherDashboard {
  const classroomsQuery = useClassrooms()
  const classrooms = useMemo(() => classroomsQuery.data ?? [], [classroomsQuery.data])

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedClassroom = useMemo(
    () => classrooms.find((entry) => entry.id === focusedId) ?? classrooms[0] ?? null,
    [classrooms, focusedId],
  )

  const todoQuery = useQuery<TeacherTodoResponse>(
    ['lms', 'teacher-todo'],
    () => getTeacherTodo(),
    { enabled: classrooms.length > 0, staleTime: 60_000 },
  )

  const calendarQuery = useQuery<CalendarResponse>(
    ['lms', 'calendar', 'dashboard'],
    () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start.getTime() + DEADLINE_HORIZON_DAYS * 86_400_000)
      return getCalendar({ start: start.toISOString(), end: end.toISOString() })
    },
    { staleTime: 120_000 },
  )

  const notificationsQuery = useQuery<readonly LmsNotification[]>(
    ['lms', 'notifications', 'dashboard'],
    async () => (await listNotifications(50)).notifications,
    { staleTime: 30_000, refetchInterval: 60_000 },
  )

  const factsQuery = useClassFacts(focusedClassroom)

  const schedule = useMemo(
    () =>
      classrooms.length && todoQuery.data
        ? buildTodaySchedule(classrooms, todoQuery.data)
        : null,
    [classrooms, todoQuery.data],
  )

  const pendingReviews = useMemo(
    () =>
      todoQuery.data
        ? buildPendingReviews({
            classrooms,
            todo: todoQuery.data,
            notifications: notificationsQuery.data ?? [],
            focusedFacts: factsQuery.data,
          })
        : null,
    [classrooms, todoQuery.data, notificationsQuery.data, factsQuery.data],
  )

  const deadlines = useMemo(() => buildDeadlines(calendarQuery.data), [calendarQuery.data])

  const interventions = useMemo(
    () => (factsQuery.data ? buildInterventionQueue(factsQuery.data) : null),
    [factsQuery.data],
  )

  const insights = useMemo(
    () => (factsQuery.data ? buildInsights(factsQuery.data) : []),
    [factsQuery.data],
  )

  const recommendations = useMemo(() => buildRecommendations(insights), [insights])

  const refetchAll = useCallback(() => {
    void classroomsQuery.refetch()
    void todoQuery.refetch()
    void calendarQuery.refetch()
    void notificationsQuery.refetch()
    void factsQuery.refetch()
  }, [classroomsQuery, todoQuery, calendarQuery, notificationsQuery, factsQuery])

  return {
    classrooms,
    focusedClassroom,
    setFocusedClassroomId: setFocusedId,
    schedule,
    pendingReviews,
    deadlines,
    interventions,
    recommendations: recommendations.items,
    recommendationTotal: recommendations.total,
    insights,
    classroomsQuery,
    todoQuery,
    calendarQuery,
    notificationsQuery,
    factsQuery,
    refetchAll,
  }
}
