import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SuggestedAction } from '../../shared/types/common'
import { type QuickActionId, useQuickAction } from './useQuickAction'

/**
 * One place that turns a `SuggestedAction` into something happening.
 *
 * Every recommendation, risk row and insight emits actions in the same shape,
 * so the dispatcher is what makes "accept this recommendation → the workflow
 * runs" true across all three surfaces rather than re-wired per card.
 */
export function useActionDispatch(): (action: SuggestedAction) => void {
  const navigate = useNavigate()
  const { open } = useQuickAction()

  return useCallback(
    (action: SuggestedAction) => {
      const { classroomId, courseworkId, studentId } = action.params

      switch (action.kind) {
        case 'open-classroom':
          if (classroomId) navigate(`/classes/${classroomId}`)
          return
        case 'open-coursework':
        case 'grade-submissions':
          if (classroomId && courseworkId) navigate(`/classes/${classroomId}/work/${courseworkId}`)
          else if (classroomId) navigate(`/classes/${classroomId}`)
          return
        case 'open-student':
          navigate(
            studentId
              ? `/interventions?student=${encodeURIComponent(studentId)}`
              : '/interventions',
          )
          return
        default:
          // Everything else is a quick action; the modal owns the form and the
          // workflow run.
          open(action.kind as QuickActionId, action.params)
      }
    },
    [navigate, open],
  )
}
