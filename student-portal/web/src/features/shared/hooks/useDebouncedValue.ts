import { useEffect, useState } from 'react'

/** Delay a fast-changing UI value (search input) before it drives derived state. */
export function useDebouncedValue<T>(value: T, delayMs = 220): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
