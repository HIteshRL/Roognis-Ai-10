/**
 * Minimal server-state cache.
 *
 * Server state is kept strictly separate from UI state (which lives in
 * component `useState`) and from derived state (which is computed by pure
 * selectors in each feature's `services/`). This module owns exactly one thing:
 * the cached result of a request, keyed and invalidatable.
 *
 * It deliberately stops short of a data-fetching library — the SPA already
 * ships with no such dependency and §13 forbids incidental stack migrations.
 * What it does provide is what the Command Center actually needs: in-flight
 * deduplication, staleness, prefix invalidation after a write, and
 * subscriber notification so two panels reading the same key stay consistent.
 */

export type QueryKey = readonly (string | number | boolean | null | undefined)[]

export const serializeKey = (key: QueryKey): string => key.map((part) => String(part)).join('␟')

export interface Snapshot<T> {
  readonly data: T | null
  readonly error: Error | null
  readonly updatedAt: number
  readonly loading: boolean
}

interface CacheEntry<T = unknown> {
  data: T | null
  error: Error | null
  updatedAt: number
  inflight: Promise<T> | null
  subscribers: Set<() => void>
  /**
   * `useSyncExternalStore` compares snapshots by identity and throws
   * "getSnapshot should be cached" if a new object comes back each read. So the
   * snapshot is materialised here and only replaced when something in it
   * actually changed.
   */
  snapshot: Snapshot<unknown>
}

/** Stable snapshot for keys that have never been fetched. */
const EMPTY_SNAPSHOT: Snapshot<never> = Object.freeze({
  data: null,
  error: null,
  updatedAt: 0,
  loading: false,
})

const cache = new Map<string, CacheEntry>()

/**
 * Bumped by `clearQueryCache`. A request that started before the bump must not
 * write its result into the cache afterwards — on sign-out that would restore
 * the previous user's data behind the new one's back.
 */
let generation = 0

function entryFor(key: string): CacheEntry {
  let entry = cache.get(key)
  if (!entry) {
    entry = {
      data: null,
      error: null,
      updatedAt: 0,
      inflight: null,
      subscribers: new Set(),
      snapshot: EMPTY_SNAPSHOT,
    }
    cache.set(key, entry)
  }
  return entry
}

/** Rebuild the snapshot, then wake subscribers. Always call these together. */
const notify = (entry: CacheEntry): void => {
  entry.snapshot = {
    data: entry.data,
    error: entry.error,
    updatedAt: entry.updatedAt,
    loading: entry.inflight !== null,
  }
  entry.subscribers.forEach((listener) => listener())
}

export function subscribe(key: string, listener: () => void): () => void {
  const entry = entryFor(key)
  entry.subscribers.add(listener)
  return () => {
    entry.subscribers.delete(listener)
  }
}

/** Returns the entry's cached snapshot — a stable reference between changes. */
export function read<T>(key: string): Snapshot<T> {
  return (cache.get(key)?.snapshot ?? EMPTY_SNAPSHOT) as Snapshot<T>
}

/**
 * Run `fetcher` for `key`, deduplicating concurrent callers. A cached value
 * newer than `staleTime` short-circuits unless `force` is set.
 */
export function fetchQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { staleTime?: number; force?: boolean } = {},
): Promise<T> {
  const { staleTime = 30_000, force = false } = options
  const entry = entryFor(key)

  if (entry.inflight) return entry.inflight as Promise<T>

  const fresh = entry.updatedAt > 0 && Date.now() - entry.updatedAt < staleTime
  if (!force && fresh && entry.error === null) {
    return Promise.resolve(entry.data as T)
  }

  // Captured before the request starts; compared on settle so a result that
  // arrives after a clearQueryCache() (i.e. after a sign-out) is discarded
  // rather than written back into the fresh session's cache.
  const startedAt = generation

  const request = fetcher()
    .then((data) => {
      if (startedAt !== generation) return data
      entry.data = data
      entry.error = null
      entry.updatedAt = Date.now()
      return data
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (startedAt !== generation) throw error
      entry.error = error
      entry.updatedAt = Date.now()
      throw error
    })
    .finally(() => {
      if (startedAt !== generation) return
      entry.inflight = null
      notify(entry)
    })

  entry.inflight = request as Promise<unknown>
  notify(entry)
  return request
}

/** Overwrite a cached value — used by optimistic mutations. */
export function setQueryData<T>(key: string, updater: T | ((previous: T | null) => T)): void {
  const entry = entryFor(key)
  entry.data =
    typeof updater === 'function' ? (updater as (previous: T | null) => T)(entry.data as T | null) : updater
  entry.error = null
  entry.updatedAt = Date.now()
  notify(entry)
}

/**
 * Mark every key beginning with `prefix` as stale and wake its subscribers.
 * Called after a write so dependent panels reload without manual plumbing.
 */
export function invalidate(prefix: QueryKey): void {
  const needle = serializeKey(prefix)
  for (const [key, entry] of cache.entries()) {
    if (key === needle || key.startsWith(`${needle}␟`)) {
      entry.updatedAt = 0
      notify(entry)
    }
  }
}

/**
 * Test and sign-out hook: drop every cached value.
 *
 * Three things here are deliberate and each fixes a way the previous
 * implementation (`for (…) notify(entry); cache.clear()`) failed to do what its
 * name promised:
 *
 * 1. **Reset in place; never `cache.clear()`.** `subscribe` closes over the
 *    *entry object*, so clearing the Map orphans every live subscriber — the
 *    next `entryFor` builds a fresh entry with a fresh subscriber Set and the
 *    mounted components are never woken again. Entries with no subscribers are
 *    dropped, so this still releases memory.
 * 2. **Clear the fields before notifying.** `notify` rebuilds the snapshot from
 *    `entry.data`, so notifying first just re-published the same data.
 * 3. **Bump the generation.** An in-flight request started by the signed-out
 *    user resolves *after* the clear and would otherwise write their data back
 *    into the cache — the exact leak this function exists to prevent.
 */
export function clearQueryCache(): void {
  generation += 1
  for (const [key, entry] of cache.entries()) {
    entry.data = null
    entry.error = null
    entry.updatedAt = 0
    entry.inflight = null
    if (entry.subscribers.size === 0) {
      cache.delete(key)
      continue
    }
    notify(entry)
  }
}
