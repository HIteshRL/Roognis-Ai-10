/**
 * Per-teacher UI preferences: bookmarked timeline events, dismissed insights,
 * accepted recommendations.
 *
 * These are view-state, not learning evidence. §13's ban on `localStorage`
 * covers *event-pipeline data* — anything that must survive as measurement —
 * and none of this qualifies: losing a bookmark costs a teacher one click and
 * corrupts no evidence stream. It is stored locally behind the
 * `PreferenceStore` interface so a server-backed implementation can replace it
 * without touching a component.
 *
 * Storage is namespaced per user id, so two teachers on a shared machine never
 * see each other's dismissals.
 */

export interface PreferenceStore {
  readonly has: (collection: string, id: string) => boolean
  readonly list: (collection: string) => readonly string[]
  readonly add: (collection: string, id: string) => void
  readonly remove: (collection: string, id: string) => void
  readonly toggle: (collection: string, id: string) => boolean
  readonly subscribe: (listener: () => void) => () => void
}

export const COLLECTIONS = {
  bookmarkedEvents: 'bookmarked-events',
  dismissedInsights: 'dismissed-insights',
  acceptedInsights: 'accepted-insights',
  resolvedInterventions: 'resolved-interventions',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

const listeners = new Set<() => void>()

/**
 * Monotonic version stamp. `useSyncExternalStore` needs a snapshot that changes
 * on every mutation — including an in-place value edit, which no property of
 * `localStorage` itself would reflect.
 */
let version = 0
export const getPreferencesVersion = (): number => version

const notify = (): void => {
  version += 1
  listeners.forEach((listener) => listener())
}

const storageKey = (userId: string, collection: string): string =>
  `roognis:prefs:${userId}:${collection}`

function readSet(userId: string, collection: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, collection))
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch {
    // Private browsing or a corrupt entry: preferences degrade to empty rather
    // than taking the page down.
    return new Set()
  }
}

function writeSet(userId: string, collection: string, values: Set<string>): void {
  try {
    window.localStorage.setItem(storageKey(userId, collection), JSON.stringify([...values]))
  } catch {
    /* Quota or private mode — the in-session UI still reflects the change. */
  }
}

export function createPreferenceStore(userId: string): PreferenceStore {
  return {
    has: (collection, id) => readSet(userId, collection).has(id),
    list: (collection) => [...readSet(userId, collection)],
    add: (collection, id) => {
      const values = readSet(userId, collection)
      values.add(id)
      writeSet(userId, collection, values)
      notify()
    },
    remove: (collection, id) => {
      const values = readSet(userId, collection)
      values.delete(id)
      writeSet(userId, collection, values)
      notify()
    },
    toggle: (collection, id) => {
      const values = readSet(userId, collection)
      const next = !values.has(id)
      if (next) values.add(id)
      else values.delete(id)
      writeSet(userId, collection, values)
      notify()
      return next
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
