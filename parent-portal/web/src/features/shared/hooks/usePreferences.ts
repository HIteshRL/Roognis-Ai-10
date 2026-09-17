import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../../../auth/AuthContext'
import {
  type PreferenceStore,
  createPreferenceStore,
  getPreferencesVersion,
} from '../services/preferenceStore'

/**
 * Preference store bound to the signed-in user, re-rendering subscribers on
 * every change so a bookmark toggled on one card updates a counter elsewhere.
 */
export function usePreferences(): PreferenceStore {
  const { user } = useAuth()
  const userId = user?.userId ?? 'anonymous'
  const store = useMemo(() => createPreferenceStore(userId), [userId])

  // Re-render on any preference mutation, including in-place value edits.
  useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    getPreferencesVersion,
  )

  return store
}
