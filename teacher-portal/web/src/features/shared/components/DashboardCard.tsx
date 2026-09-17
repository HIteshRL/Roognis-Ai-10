import type { ReactNode } from 'react'
import { EmptyState, Icon, Spinner } from '../../../components/ui'
import type { AsyncStatus } from '../types/common'

export interface DashboardCardProps {
  readonly title: string
  readonly icon?: string
  readonly subtitle?: string
  /** Right-aligned control in the header (a link, a filter, a count). */
  readonly action?: ReactNode
  /** Drives the internal loading / error / empty rendering. */
  readonly status?: AsyncStatus
  readonly error?: Error | null
  readonly refreshing?: boolean
  /** Keep the last successful body visible when a background refresh fails. */
  readonly hasData?: boolean
  readonly isEmpty?: boolean
  readonly emptyIcon?: string
  readonly emptyTitle?: string
  readonly emptyHint?: string
  readonly onRetry?: () => void
  /** Let the body scroll instead of stretching the dashboard row. */
  readonly maxBodyHeight?: number
  readonly footer?: ReactNode
  readonly children?: ReactNode
}

/**
 * The one card shell every Command Center section uses. It owns the four render
 * states so no section reimplements them, which is what keeps a dashboard of
 * six independent async panels visually coherent.
 */
export function DashboardCard({
  title,
  icon,
  subtitle,
  action,
  status = 'success',
  error = null,
  refreshing = false,
  hasData = false,
  isEmpty = false,
  emptyIcon = 'inbox',
  emptyTitle = 'Nothing here',
  emptyHint,
  onRetry,
  maxBodyHeight,
  footer,
  children,
}: DashboardCardProps): JSX.Element {
  const showSkeleton = status === 'loading' || status === 'idle'

  return (
    <section className="card cc-card" aria-busy={showSkeleton || refreshing}>
      <header className="cc-card-head">
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          {icon && (
            <span className="cc-card-icon" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <h2 className="cc-card-title">{title}</h2>
            {subtitle && <div className="tiny faint">{subtitle}</div>}
          </div>
          {refreshing && <Spinner size={13} />}
        </div>
        {action && <div className="row" style={{ gap: 6 }}>{action}</div>}
      </header>

      <div
        className="cc-card-body"
        style={maxBodyHeight ? { maxHeight: maxBodyHeight, overflowY: 'auto' } : undefined}
      >
        {status === 'error' && !hasData ? (
          <EmptyState
            icon="warning"
            title="Couldn’t load this"
            hint={error?.message ?? 'The service did not respond.'}
            action={
              onRetry ? (
                <button className="btn btn-outline btn-sm" onClick={onRetry}>
                  Try again
                </button>
              ) : undefined
            }
          />
        ) : showSkeleton ? (
          <div className="col" style={{ gap: 10, padding: '4px 0' }} aria-hidden="true">
            <div className="skeleton" style={{ height: 15, width: '62%' }} />
            <div className="skeleton" style={{ height: 15, width: '88%' }} />
            <div className="skeleton" style={{ height: 15, width: '45%' }} />
          </div>
        ) : isEmpty ? (
          <EmptyState icon={emptyIcon} title={emptyTitle} hint={emptyHint} />
        ) : (
          <>
            {status === 'error' ? <p className="learning-refresh-error" role="alert">Couldn’t refresh this panel. Showing the last available result.</p> : null}
            {children}
          </>
        )}
      </div>

      {footer && (status === 'success' || hasData) && !isEmpty && <div className="cc-card-foot">{footer}</div>}
    </section>
  )
}
