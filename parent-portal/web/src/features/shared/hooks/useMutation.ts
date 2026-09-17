/**
 * Writes, with optimistic updates and rollback.
 *
 * `optimistic` patches the cache before the request leaves, keeping the snapshot
 * it replaced. If the request fails the snapshot is restored, so a failed pin or
 * a rejected grade never leaves the UI asserting something the server rejected.
 * `invalidates` lists key prefixes to mark stale on success.
 */

import { useCallback, useRef, useState } from 'react'
import {
  type QueryKey,
  invalidate,
  read,
  serializeKey,
  setQueryData,
} from '../state/queryCache'

export interface OptimisticPatch<TInput> {
  readonly key: QueryKey
  /** Pure: given the cached value and the input, return the projected value. */
  readonly apply: (previous: unknown, input: TInput) => unknown
}

export interface UseMutationOptions<TInput, TResult> {
  readonly optimistic?: readonly OptimisticPatch<TInput>[]
  readonly invalidates?: readonly QueryKey[]
  readonly onSuccess?: (result: TResult, input: TInput) => void
  readonly onError?: (error: Error, input: TInput) => void
}

export interface UseMutationResult<TInput, TResult> {
  readonly mutate: (input: TInput) => Promise<TResult | null>
  readonly pending: boolean
  readonly error: Error | null
  readonly reset: () => void
}

export function useMutation<TInput, TResult>(
  mutator: (input: TInput) => Promise<TResult>,
  options: UseMutationOptions<TInput, TResult> = {},
): UseMutationResult<TInput, TResult> {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options
  const mutatorRef = useRef(mutator)
  mutatorRef.current = mutator

  const mutate = useCallback(async (input: TInput): Promise<TResult | null> => {
    const { optimistic = [], invalidates = [], onSuccess, onError } = optionsRef.current
    const rollbacks: Array<() => void> = []

    for (const patch of optimistic) {
      const key = serializeKey(patch.key)
      const previous = read<unknown>(key).data
      rollbacks.push(() => setQueryData(key, previous))
      setQueryData(key, patch.apply(previous, input))
    }

    setPending(true)
    setError(null)
    try {
      const result = await mutatorRef.current(input)
      invalidates.forEach((key) => invalidate(key))
      onSuccess?.(result, input)
      return result
    } catch (cause) {
      rollbacks.forEach((undo) => undo())
      const wrapped = cause instanceof Error ? cause : new Error(String(cause))
      setError(wrapped)
      onError?.(wrapped, input)
      return null
    } finally {
      setPending(false)
    }
  }, [])

  return { mutate, pending, error, reset: useCallback(() => setError(null), []) }
}
