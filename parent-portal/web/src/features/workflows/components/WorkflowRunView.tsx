import { CAPABILITIES } from '../../shared/services/capability'
import type { StepStatus, WorkflowRun } from '../types/workflow'

const DOT: Readonly<Record<StepStatus, { className: string; glyph: string; label: string }>> = {
  pending: { className: '', glyph: '·', label: 'Pending' },
  running: { className: 'wf-dot-active', glyph: '◍', label: 'Running' },
  done: { className: 'wf-dot-done', glyph: '✓', label: 'Done' },
  blocked: { className: 'wf-dot-blocked', glyph: '⏸', label: 'Awaiting backend' },
  failed: { className: 'wf-dot-failed', glyph: '✕', label: 'Failed' },
  skipped: { className: '', glyph: '–', label: 'Skipped' },
}

/**
 * Live view of a workflow run.
 *
 * `blocked` is styled distinctly from `failed` on purpose: one means the
 * backend does not exist yet, the other means something went wrong with work
 * the teacher asked for. Collapsing them would teach teachers to ignore real
 * errors.
 */
export function WorkflowRunView({ run }: { run: WorkflowRun }): JSX.Element {
  return (
    <ol className="wf-steps" aria-live="polite">
      {run.steps.map((step) => {
        const dot = DOT[step.status]
        const capability = step.requires ? CAPABILITIES[step.requires] : null

        return (
          <li className="wf-step" key={step.id}>
            <span className={`wf-dot ${dot.className}`} aria-hidden="true">
              {dot.glyph}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span
                  className="small"
                  style={{
                    fontWeight: 650,
                    color: step.status === 'pending' ? 'var(--text-faint)' : 'var(--text)',
                  }}
                >
                  {step.title}
                </span>
                <span className="tiny faint">{dot.label}</span>
                {step.manual && <span className="tiny faint">· needs a human</span>}
              </div>

              <div className="tiny muted" style={{ marginTop: 2 }}>
                {step.detail ?? step.description}
              </div>

              {step.status === 'failed' && step.error && (
                <div className="tiny" style={{ color: 'var(--rose-500)', marginTop: 3 }}>
                  {step.error}
                </div>
              )}

              {step.status === 'blocked' && capability && (
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  Needs <code>{capability.endpoint}</code> · {capability.architectureRef}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
