import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from '../api/client'
import { clearQueryCache } from '../features/shared/state/queryCache'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const user = await api.me()
      setUser(user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The query cache is module-scoped, so it outlives a sign-out in the same
  // tab. Most keys are not scoped by user or role (only useClassrooms is), so
  // without this a student signing in after a teacher on a shared machine
  // paints the teacher's cached calendar/notifications/class facts on the
  // first frame. Cleared on both ends of the transition: logout covers the
  // normal path, login covers arriving at the login page by session expiry
  // with no logout ever having run.
  const login = async (email, password) => {
    clearQueryCache()
    const user = await api.login(email, password)
    setUser(user)
    return user
  }
  const logout = async () => {
    try {
      await api.logout()
    } finally {
      clearQueryCache()
      setUser(null)
    }
  }

  return <AuthCtx.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthCtx.Provider>
}

export const useAuth = () => useContext(AuthCtx)
