import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  readonly children: ReactNode
}

interface State {
  readonly error: Error | null
}

/**
 * There was no error boundary anywhere in the tree before this. App.tsx lazy-
 * loads every route chunk under a bare <Suspense>, so after a deploy a client
 * holding a stale index.html requests a hashed chunk that no longer exists;
 * the dynamic import rejects with no boundary above it to catch it, and React
 * unmounts the whole tree — a blank page with nothing in the UI to explain it
 * or offer a reload, only a console error the user never sees.
 *
 * Chunk-load failures specifically are the case worth naming distinctly: they
 * are the one class of render error a plain reload actually fixes (it picks
 * up the current index.html and its current chunk hashes), so the copy steers
 * the user toward that action instead of a generic "something went wrong".
 */
function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Failed to fetch|Loading chunk/i.test(error.message)
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const chunkError = isChunkLoadError(error)
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="card card-pad" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>{chunkError ? '🔄' : '⚠️'}</div>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>
            {chunkError ? 'A new version is available' : 'Something went wrong'}
          </h2>
          <p className="small muted" style={{ marginBottom: 16 }}>
            {chunkError
              ? 'This page was updated since you loaded it. Reload to get the latest version.'
              : 'This screen hit an unexpected error and could not continue.'}
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
