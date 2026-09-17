/**
 * Types for the existing `client.js` fetch wrapper. The runtime implementation
 * is unchanged and remains the single HTTP entry point for the whole SPA —
 * this file only gives TypeScript callers a checked view of it.
 */

export declare class ApiError extends Error {
  readonly name: 'ApiError'
  readonly status: number
  readonly data: unknown
  constructor(message: string, status: number, data: unknown)
}

export interface AuthUser {
  readonly userId: string
  readonly role: 'teacher' | 'student' | 'parent'
  readonly schoolId: string
  readonly name: string
  readonly studentIds?: readonly string[]
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string): Promise<T>
  upload<T = unknown>(path: string, formData: FormData): Promise<T>
  login(email: string, password: string): Promise<AuthUser>
  register(input: {
    name: string
    email: string
    password: string
    role: 'student' | 'parent'
    schoolId: string
  }): Promise<{ userId: string; role: 'student' | 'parent' }>
  me(): Promise<AuthUser>
  logout(): Promise<unknown>
}

export declare const api: ApiClient
