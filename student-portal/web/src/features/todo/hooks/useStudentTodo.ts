import { useQuery } from '../../shared/hooks/useQuery'
import { getStudentTodo } from '../../shared/services/lmsService'
import type { StudentTodoResponse } from '../../shared/types/lms'

/** Sprint 1, T4.4 — backs the `/classes` to-do panel. */
export function useStudentTodo() {
  return useQuery<StudentTodoResponse>(['lms', 'student-todo'], getStudentTodo, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}
