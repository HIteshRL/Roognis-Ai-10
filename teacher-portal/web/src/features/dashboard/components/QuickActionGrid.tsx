import { Icon } from '../../../components/ui'
import { CAPABILITIES } from '../../shared/services/capability'
import type { SuggestedAction } from '../../shared/types/common'
import type { QuickAction } from '../types/dashboard'

/**
 * The six large actions.
 *
 * Actions whose backend does not exist are still shown and still clickable —
 * they open the modal, which explains precisely what is missing. Hiding them
 * would make the product look smaller than it is; disabling them silently would
 * be worse.
 */
export function QuickActionGrid({
  actions,
  classroomId,
  onAction,
}: {
  actions: readonly QuickAction[]
  classroomId: string | null
  onAction: (action: SuggestedAction) => void
}): JSX.Element {
  return (
    <div className="qa-grid">
      {actions.map((action) => {
        const capability = action.capability ? CAPABILITIES[action.capability] : null
        return (
          <button
            key={action.id}
            className="qa-btn"
            onClick={() =>
              onAction({
                id: action.id,
                label: action.label,
                kind: action.kind,
                intent: 'primary',
                params: classroomId ? { classroomId } : {},
              })
            }
          >
            <span className="qa-btn-icon" aria-hidden="true">
              <Icon name={action.icon} size={20} />
            </span>
            <span className="qa-btn-label">{action.label}</span>
            <span className="qa-btn-hint">{capability ? capability.label : action.hint}</span>
            {capability && (
              <span className="tiny faint" style={{ marginTop: 2 }}>
                {capability.reason === 'blocked' ? 'Gated by school setup' : 'Not provisioned'}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
