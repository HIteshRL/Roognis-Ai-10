import { type ReactNode, useCallback, useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

/**
 * Right-anchored detail drawer used for insight details, intervention details
 * and workflow runs.
 *
 * A drawer is a modal surface, so it carries the full modal contract: focus
 * moves in on open and returns to the trigger on close, Tab is trapped, Escape
 * closes, background scrolling is locked, and the title is wired to
 * `aria-labelledby`. Without these it is a div that merely looks like a dialog.
 */
export function ActionDrawer({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  width?: number
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<HTMLElement | null>(null)

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const targets = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null,
      )
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  useEffect(() => {
    if (!open) return
    restoreFocusTo.current = document.activeElement as HTMLElement | null

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown, true)

    // Focus the panel itself rather than its first control, so a screen reader
    // announces the drawer title before its actions.
    panelRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      restoreFocusTo.current?.focus?.()
    }
  }, [open, onKeyDown])

  if (!open) return null

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="drawer-panel"
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="drawer-title" style={{ fontSize: 17 }}>
              {title}
            </h2>
            {subtitle && <div className="tiny faint" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </header>

        <div className="drawer-body">{children}</div>

        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </div>
  )
}
