import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ActionKind } from '../../shared/types/common'

/**
 * Quick actions live in the URL (`?action=create-assignment&classroomId=…`).
 *
 * Routing the modal rather than holding it in component state means an action
 * is linkable, survives a refresh, and closes with the browser back button —
 * which is what a teacher expects from anything that feels like a page.
 */
export type QuickActionId = Extract<
  ActionKind,
  | 'create-assignment'
  | 'create-quiz'
  | 'upload-material'
  | 'generate-lesson'
  | 'take-attendance'
  | 'post-announcement'
  | 'schedule-revision'
  | 'message-guardian'
>

const VALID: ReadonlySet<string> = new Set<QuickActionId>([
  'create-assignment',
  'create-quiz',
  'upload-material',
  'generate-lesson',
  'take-attendance',
  'post-announcement',
  'schedule-revision',
  'message-guardian',
])

export interface QuickActionState {
  readonly action: QuickActionId | null
  readonly params: Readonly<Record<string, string>>
  readonly open: (action: QuickActionId, params?: Readonly<Record<string, string>>) => void
  readonly close: () => void
}

export function useQuickAction(): QuickActionState {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get('action')
  const action = raw && VALID.has(raw) ? (raw as QuickActionId) : null

  const params = useMemo(() => {
    const entries: Record<string, string> = {}
    searchParams.forEach((value, key) => {
      if (key !== 'action') entries[key] = value
    })
    return entries
  }, [searchParams])

  const open = useCallback(
    (next: QuickActionId, extra: Readonly<Record<string, string>> = {}) => {
      const params = new URLSearchParams()
      params.set('action', next)
      for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value)
      setSearchParams(params)
    },
    [setSearchParams],
  )

  const close = useCallback(() => {
    // `replace` so closing does not leave the modal in the back stack.
    setSearchParams(new URLSearchParams(), { replace: true })
  }, [setSearchParams])

  return { action, params, open, close }
}
