/**
 * Client-side windowing over an already-materialised list.
 *
 * The timeline merges several LMS collections that have no shared cursor
 * (`/announcements` and `/coursework` are separate, unpaginated endpoints), so
 * the merge has to happen client-side before anything can be paged. This hook
 * therefore pages the *merged* list and exposes an `IntersectionObserver`
 * sentinel ref for infinite scroll.
 *
 * When the LMS grows a unified, cursor-paged timeline endpoint, only
 * `useTimeline` changes — this hook and the components stay as they are.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface UseInfiniteListResult<T> {
  readonly visible: readonly T[]
  readonly hasMore: boolean
  readonly loadMore: () => void
  readonly sentinelRef: (node: HTMLElement | null) => void
  readonly shownCount: number
  readonly totalCount: number
}

export function useInfiniteList<T>(
  items: readonly T[],
  pageSize = 12,
  /**
   * Changes to this string reset the window. It must describe the *query*
   * (filter, search term), not the result array: keying the reset on the array
   * itself means any re-render that produces a new array reference snaps the
   * user back to the first page — which reads as infinite scroll being broken.
   */
  resetKey = '',
): UseInfiniteListResult<T> {
  const [limit, setLimit] = useState(pageSize)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    setLimit(pageSize)
  }, [resetKey, pageSize])

  const hasMore = limit < items.length

  // Deliberately independent of `items.length`, so the callback — and the
  // observer built from it — keeps a stable identity across renders.
  const loadMore = useCallback(() => {
    setLimit((current) => current + pageSize)
  }, [pageSize])

  const sentinelRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect()
      if (!node) return
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0]
          if (entry?.isIntersecting) loadMore()
        },
        { rootMargin: '320px 0px' },
      )
      observer.observe(node)
      observerRef.current = observer
    },
    [loadMore],
  )

  useEffect(() => () => observerRef.current?.disconnect(), [])

  // `limit` may exceed the list after a filter narrows it; slice clamps for us.
  const visible = useMemo(() => items.slice(0, limit), [items, limit])

  return {
    visible,
    hasMore,
    loadMore,
    sentinelRef,
    shownCount: visible.length,
    totalCount: items.length,
  }
}
