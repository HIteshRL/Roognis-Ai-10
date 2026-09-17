import { type ClassFacts, loadClassFacts } from '../services/classFacts'
import type { Classroom } from '../types/lms'
import { type UseQueryResult, useQuery } from './useQuery'

/**
 * Derived facts for one class.
 *
 * This is the expensive read in the product — a gradebook plus submissions for
 * the recent-task window — so it is deliberately scoped to a single, chosen
 * class rather than fanned out across every class a teacher owns. Cached for
 * two minutes: grading changes the picture, but not second to second.
 */
export function useClassFacts(classroom: Classroom | null): UseQueryResult<ClassFacts> {
  return useQuery<ClassFacts>(
    ['facts', 'class', classroom?.id],
    () => {
      if (!classroom) throw new Error('No classroom selected')
      return loadClassFacts(classroom)
    },
    { enabled: Boolean(classroom), staleTime: 120_000 },
  )
}
