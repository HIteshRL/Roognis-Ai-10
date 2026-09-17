import type { CapabilitySpec } from '../services/capability'
import { Icon } from '../../../components/ui'

/**
 * Rendered where a panel's backend does not exist yet.
 *
 * It names the owning service, the endpoint the client is ready to call, and
 * the architecture section that governs it — so this doubles as the delivery
 * checklist. `blocked` capabilities are deliberately sequenced later by
 * `ARCHITECTUREDesign.md`; `missing` ones are simply unbuilt. The distinction
 * matters: one is a decision, the other is a gap.
 */
export function CapabilityNotice({
  capability,
  compact = false,
}: {
  capability: CapabilitySpec
  compact?: boolean
}): JSX.Element {
  const blocked = capability.reason === 'blocked'

  return (
    <div className={`cap-notice${blocked ? ' cap-notice-blocked' : ''}`} role="note">
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <span aria-hidden="true" className="cap-notice-icon">
          <Icon name={blocked ? 'warning' : 'settings'} size={15} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="small" style={{ fontWeight: 700 }}>
            {blocked ? 'Gated by the build sequence' : 'Awaiting backend'} · {capability.label}
          </div>
          {!compact && (
            <>
              <div className="small muted" style={{ marginTop: 3 }}>
                {capability.blocks}
              </div>
              <dl className="cap-meta">
                <div>
                  <dt>Service</dt>
                  <dd>
                    <code>{capability.service}</code>
                  </dd>
                </div>
                <div>
                  <dt>Endpoint</dt>
                  <dd>
                    <code>{capability.endpoint}</code>
                  </dd>
                </div>
                <div>
                  <dt>Governed by</dt>
                  <dd>{capability.architectureRef}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
