/**
 * Types for the existing `AuthContext.jsx`. The provider implementation is
 * unchanged; this only gives TypeScript consumers a checked view of the
 * context value.
 */
import type { ReactNode } from 'react'
import type { AuthUser } from '../api/client'

export interface AuthContextValue {
  readonly user: AuthUser | null
  readonly loading: boolean
  readonly login: (role: string) => Promise<AuthUser>
  readonly logout: () => Promise<void>
  readonly refresh: () => Promise<void>
}

export declare function AuthProvider(props: { children?: ReactNode }): JSX.Element
export declare function useAuth(): AuthContextValue
