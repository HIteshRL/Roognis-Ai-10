import { Badge } from '../../../components/ui'
import type { BadgeTone } from '../../../components/ui'
import type { Priority } from '../types/common'

const TONE: Readonly<Record<Priority, BadgeTone>> = {
  critical: 'danger',
  high: 'warn',
  medium: 'primary',
  low: 'default',
}

const LABEL: Readonly<Record<Priority, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/**
 * Priority is carried by colour *and* by text — colour alone would fail the
 * non-colour-cue requirement of WCAG 1.4.1.
 */
export function PriorityBadge({ priority }: { priority: Priority }): JSX.Element {
  return (
    <Badge tone={TONE[priority]} dot>
      {LABEL[priority]}
    </Badge>
  )
}
