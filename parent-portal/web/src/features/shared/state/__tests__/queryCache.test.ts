import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  clearQueryCache,
  fetchQuery,
  invalidate,
  read,
  serializeKey,
  setQueryData,
  subscribe,
} from '../queryCache'

/**
 * The cache is module-scoped and every test shares it, so each test starts by
 * clearing it. Keys are also namespaced per test where it matters, since a
 * leaked key between tests is exactly the class of bug this suite exists to
 * catch and it should not be able to hide behind a shared name.
 */
beforeEach(() => {
  clearQueryCache()
})

const key = (name: string) => serializeKey(['test', name])

describe('serializeKey', () => {
  it('joins parts with a separator that cannot appear in a normal key', () => {
    expect(serializeKey(['lms', 'classrooms', 'teacher'])).toBe('lms␟classrooms␟teacher')
  })

  it('does not collide when a part boundary shifts', () => {
    expect(serializeKey(['a', 'b'])).not.toBe(serializeKey(['ab']))
  })
})

describe('read', () => {
  it('returns a stable empty snapshot for an unknown key', () => {
    // useSyncExternalStore throws "getSnapshot should be cached" if this is
    // not reference-stable across reads.
    expect(read(key('unknown'))).toBe(read(key('unknown')))
  })

  it('exposes data after a successful fetch', async () => {
    await fetchQuery(key('read'), async () => ({ value: 1 }))
    expect(read<{ value: number }>(key('read')).data).toEqual({ value: 1 })
  })
})

describe('fetchQuery', () => {
  it('deduplicates concurrent callers into one request', async () => {
    const fetcher = vi.fn(async () => 'once')
    const k = key('dedup')

    const [a, b, c] = await Promise.all([
      fetchQuery(k, fetcher),
      fetchQuery(k, fetcher),
      fetchQuery(k, fetcher),
    ])

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect([a, b, c]).toEqual(['once', 'once', 'once'])
  })

  it('short-circuits a fresh value without calling the fetcher again', async () => {
    const fetcher = vi.fn(async () => 'cached')
    const k = key('fresh')

    await fetchQuery(k, fetcher)
    await fetchQuery(k, fetcher, { staleTime: 60_000 })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches once the value is older than staleTime', async () => {
    const fetcher = vi.fn(async () => 'value')
    const k = key('stale')

    await fetchQuery(k, fetcher)
    await fetchQuery(k, fetcher, { staleTime: 0 })

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refetches when force is set even if the value is fresh', async () => {
    const fetcher = vi.fn(async () => 'value')
    const k = key('force')

    await fetchQuery(k, fetcher)
    await fetchQuery(k, fetcher, { staleTime: 60_000, force: true })

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('caches the error and does not serve it as a fresh value', async () => {
    const k = key('error')
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })

    await expect(fetchQuery(k, failing)).rejects.toThrow('boom')
    expect(read(k).error?.message).toBe('boom')

    // A cached *error* must not short-circuit the next attempt the way a
    // cached value does, or a transient failure would be sticky.
    await fetchQuery(k, async () => 'recovered')
    expect(read<string>(k).data).toBe('recovered')
    expect(read(k).error).toBeNull()
  })

  it('wraps a non-Error rejection', async () => {
    const k = key('non-error')
    await expect(fetchQuery(k, async () => Promise.reject('plain string'))).rejects.toThrow(
      'plain string',
    )
    expect(read(k).error).toBeInstanceOf(Error)
  })

  it('reports loading in the snapshot while in flight, and clears it after', async () => {
    const k = key('loading')
    let release: (value: string) => void = () => {}
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })

    const inflight = fetchQuery(k, () => gate)
    expect(read(k).loading).toBe(true)

    release('done')
    await inflight
    expect(read(k).loading).toBe(false)
  })
})

describe('snapshot identity', () => {
  it('returns the same reference between changes and a new one after a change', async () => {
    const k = key('identity')
    await fetchQuery(k, async () => 'first')

    const a = read(k)
    const b = read(k)
    expect(a).toBe(b)

    setQueryData(k, 'second')
    expect(read(k)).not.toBe(a)
  })
})

describe('subscribe', () => {
  it('wakes subscribers on a fetch and stops after unsubscribe', async () => {
    const k = key('subscribe')
    const listener = vi.fn()
    const unsubscribe = subscribe(k, listener)

    await fetchQuery(k, async () => 'value')
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    listener.mockClear()
    await fetchQuery(k, async () => 'other', { force: true })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('invalidate', () => {
  it('marks an exact key stale so the next read refetches', async () => {
    const k = key('invalidate-exact')
    const fetcher = vi.fn(async () => 'value')

    await fetchQuery(k, fetcher)
    invalidate(['test', 'invalidate-exact'])
    await fetchQuery(k, fetcher, { staleTime: 60_000 })

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('marks every key under a prefix stale', async () => {
    const a = vi.fn(async () => 'a')
    const b = vi.fn(async () => 'b')

    await fetchQuery(serializeKey(['lms', 'coursework', '1']), a)
    await fetchQuery(serializeKey(['lms', 'coursework', '2']), b)

    invalidate(['lms', 'coursework'])

    await fetchQuery(serializeKey(['lms', 'coursework', '1']), a, { staleTime: 60_000 })
    await fetchQuery(serializeKey(['lms', 'coursework', '2']), b, { staleTime: 60_000 })

    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate a key that merely shares a string prefix', async () => {
    const fetcher = vi.fn(async () => 'value')
    // 'lms␟classrooms-archived' starts with 'lms␟classrooms' as a *string* but
    // is a different key; only a separator boundary counts.
    await fetchQuery(serializeKey(['lms', 'classrooms-archived']), fetcher)

    invalidate(['lms', 'classrooms'])

    await fetchQuery(serializeKey(['lms', 'classrooms-archived']), fetcher, { staleTime: 60_000 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('clearQueryCache', () => {
  it('drops cached data', async () => {
    const k = key('clear')
    await fetchQuery(k, async () => 'secret')
    expect(read<string>(k).data).toBe('secret')

    clearQueryCache()
    expect(read<string>(k).data).toBeNull()
  })

  it('hands subscribers a snapshot with the data already gone', async () => {
    const k = key('clear-notify')
    await fetchQuery(k, async () => 'secret')

    // Asserting on read() *after* clearQueryCache returns is not enough — it
    // passes even against the broken implementation. What matters is what a
    // subscriber sees at the moment it is woken, because that is the value
    // React renders. So capture it from inside the listener.
    const seen: unknown[] = []
    subscribe(k, () => {
      seen.push(read<string>(k).data)
    })

    clearQueryCache()

    // The regression: the old implementation notified *before* clearing, so
    // subscribers re-rendered with the previous user's data still in hand and
    // no further notification ever came to correct it.
    expect(seen).toEqual([null])
  })

  it('keeps live subscribers wired to future fetches', async () => {
    const k = key('clear-rewire')
    const listener = vi.fn()
    subscribe(k, listener)

    clearQueryCache()
    listener.mockClear()

    // The old implementation called cache.clear(), orphaning the entry the
    // subscriber closed over — so this fetch would never reach the listener
    // and the component would be permanently detached from the cache.
    await fetchQuery(k, async () => 'after')
    expect(listener).toHaveBeenCalled()
  })

  it('discards an in-flight response that resolves after the clear', async () => {
    const k = key('clear-inflight')
    let release: (value: string) => void = () => {}
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })

    const inflight = fetchQuery(k, () => gate)

    // Sign-out happens while the previous user's request is still open.
    clearQueryCache()

    release('previous user data')
    await inflight

    // The response must not be written back into the fresh session's cache.
    //
    // Note this test does *not* fail against the original implementation —
    // there, cache.clear() orphaned the entry, so the late write landed on a
    // detached object and was invisible. It guards the reset-in-place approach
    // used here, which keeps the entry (to preserve subscriber wiring) and so
    // would otherwise be writable by a stale request. It pins a real property;
    // it is not a regression test for the original bug.
    expect(read<string>(k).data).toBeNull()
  })

  it('discards an in-flight rejection that settles after the clear', async () => {
    const k = key('clear-inflight-error')
    let fail: (reason: Error) => void = () => {}
    const gate = new Promise<string>((_resolve, reject) => {
      fail = reject
    })

    const inflight = fetchQuery(k, () => gate)
    clearQueryCache()

    fail(new Error('stale failure'))
    await expect(inflight).rejects.toThrow('stale failure')

    expect(read(k).error).toBeNull()
  })
})
