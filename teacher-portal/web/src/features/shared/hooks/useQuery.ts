/**
 * React bindings for the server-state cache.
 *
 * `useQuery` exposes the four states a panel must render distinctly — idle,
 * loading, success, error — plus `refreshing` for a background reload over data
 * that is already on screen. Panels that conflate "loading" with "empty" are
 * the main reason dashboards feel broken, so the distinction is in the type.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { AsyncState, AsyncStatus } from '../types/common'
import {
  type QueryKey,
  fetchQuery,
  read,
  serializeKey,
  subscribe,
} from '../state/queryCache'

export interface UseQueryOptions {
  /** Skip the request entirely (e.g. waiting on a route param). */
  readonly enabled?: boolean
  /** How long a cached value counts as fresh. */
  readonly staleTime?: number
  /** Poll interval in ms. Omit for no polling. */
  readonly refetchInterval?: number
}

export interface UseQueryResult<T> extends AsyncState<T> {
  readonly refetch: () => Promise<void>
}

export function useQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const { enabled = true, staleTime = 30_000, refetchInterval } = options
  const serialized = serializeKey(key)

  // Keep the latest fetcher without making it part of the effect's identity —
  // inline closures would otherwise refire the request on every render.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const snapshot = useSyncExternalStore(
    useCallback((listener) => subscribe(serialized, listener), [serialized]),
    useCallback(() => read<T>(serialized), [serialized]),
  )

  const run = useCallback(
    async (force: boolean): Promise<void> => {
      try {
        await fetchQuery(serialized, () => fetcherRef.current(), { staleTime, force })
      } catch {
        // The cache records the error; subscribers re-render with it.
      }
    },
    [serialized, staleTime],
  )

  // `invalidate()` resets `updatedAt` to 0, so this flag flipping back to true
  // is precisely the signal to reload. It is the whole invalidation mechanism.
  const needsLoad = snapshot.updatedAt === 0

  useEffect(() => {
    if (!enabled || !needsLoad) return
    void run(false)
  }, [enabled, needsLoad, run])

  useEffect(() => {
    if (!enabled || !refetchInterval) return
    const timer = window.setInterval(() => void run(true), refetchInterval)
    return () => window.clearInterval(timer)
  }, [enabled, refetchInterval, run])

  const status: AsyncStatus = !enabled
    ? 'idle'
    : snapshot.error
      ? 'error'
      : snapshot.data !== null
        ? 'success'
        : snapshot.loading
          ? 'loading'
          : 'idle'

  return {
    status,
    data: snapshot.data,
    error: snapshot.error,
    refreshing: snapshot.loading && snapshot.data !== null,
    refetch: useCallback(() => run(true), [run]),
  }
}

/**
 * Combine several queries into one state for a panel that needs all of them.
 * Errors surface as the first error; data is null until every part resolves.
 */
export function combineQueries<T extends readonly UseQueryResult<unknown>[]>(
  results: T,
): { status: AsyncStatus; error: Error | null; refreshing: boolean } {
  const error = results.find((result) => result.error)?.error ?? null
  if (error) return { status: 'error', error, refreshing: false }
  const status: AsyncStatus = results.every((result) => result.status === 'success')
    ? 'success'
    : results.some((result) => result.status === 'loading')
      ? 'loading'
      : 'idle'
  return { status, error: null, refreshing: results.some((result) => result.refreshing) }
}
