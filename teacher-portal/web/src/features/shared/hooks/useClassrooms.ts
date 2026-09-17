import { useMemo } from 'react'
import { useAuth } from '../../../auth/AuthContext'
import { listStudentClassrooms, listTeacherClassrooms } from '../services/lmsService'
import type { Classroom } from '../types/lms'
import { type UseQueryResult, useQuery } from './useQuery'

/**
 * The signed-in user's classrooms. Teachers and students read different LMS
 * routes, so the role picks the fetcher — no caller should have to know that.
 * A guardian has neither — `/lms/classrooms` (teacher) and
 * `/lms/student/classrooms` (student) both 403 for them, which this hook is
 * mounted globally enough (`QuickActionModal` inside `AppShell`) to hit on
 * every guardian page load if left unhandled. Resolves to `[]` instead.
 * Archived classes are filtered out: the Command Center is about what needs
 * attention now.
 */
export function useClassrooms(): UseQueryResult<readonly Classroom[]> {
  const { user } = useAuth()
  const role = user?.role ?? 'teacher'

  const result = useQuery<readonly Classroom[]>(
    ['lms', 'classrooms', role],
    () => {
      if (role === 'student') return listStudentClassrooms()
      if (role === 'parent') return Promise.resolve([])
      return listTeacherClassrooms()
    },
    { staleTime: 60_000 },
  )

  const data = useMemo(
    () => (result.data ? result.data.filter((classroom) => !classroom.isArchived) : null),
    [result.data],
  )

  return { ...result, data }
}
