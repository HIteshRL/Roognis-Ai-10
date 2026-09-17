import type { CapabilityId } from '../../shared/services/capability'
import type {
  Confidence,
  Evidence,
  Priority,
  Provenance,
  StudentRef,
  SuggestedAction,
} from '../../shared/types/common'

export type InsightGroupId =
  | 'urgency'
  | 'learning'
  | 'performance'
  | 'behaviour'
  | 'curriculum'
  | 'attendance'
  | 'parents'

export interface InsightGroupSpec {
  readonly id: InsightGroupId
  readonly label: string
  readonly icon: string
  readonly description: string
  /**
   * Capabilities this group needs before it can produce anything. A group whose
   * every source is unprovisioned renders a capability notice instead of an
   * empty state, so "nothing to report" is never confused with "not built".
   */
  readonly requires: readonly CapabilityId[]
}

export const INSIGHT_GROUPS: readonly InsightGroupSpec[] = [
  {
    id: 'urgency',
    label: 'Needs you today',
    icon: 'warning',
    description: 'Work that is blocking students right now.',
    requires: [],
  },
  {
    id: 'learning',
    label: 'Learning',
    icon: 'book',
    description: 'Where the class did not get it.',
    requires: [],
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'trend',
    description: 'How results are moving over time.',
    requires: [],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    icon: 'inbox',
    description: 'Submission habits across the class.',
    requires: [],
  },
  {
    id: 'curriculum',
    label: 'Curriculum',
    icon: 'library',
    description: 'Whether the material and its difficulty are landing.',
    requires: [],
  },
  {
    id: 'attendance',
    label: 'Attendance',
    icon: 'calendar',
    description: 'Presence trends and absence clusters.',
    requires: ['lms.attendance'],
  },
  {
    id: 'parents',
    label: 'Parents',
    icon: 'family',
    description: 'Guardian messages awaiting a reply.',
    requires: ['lms.guardian-messages'],
  },
]

export type InsightStatus = 'open' | 'accepted' | 'dismissed'

export interface AIInsight {
  readonly id: string
  readonly group: InsightGroupId
  readonly title: string
  /** Plain-language statement of what was observed and why it matters. */
  readonly explanation: string
  readonly priority: Priority
  readonly confidence: Confidence
  readonly evidence: readonly Evidence[]
  /** Named only where the teacher already owns the underlying LMS records. */
  readonly affectedStudents: readonly StudentRef[]
  readonly actions: readonly SuggestedAction[]
  readonly provenance: Provenance
  readonly classroomId: string
  readonly classroomName: string
  readonly detectedAt: string
  /** How the observation was computed, quoted verbatim in the detail drawer. */
  readonly method: string
}

export interface InsightGroupResult {
  readonly spec: InsightGroupSpec
  readonly insights: readonly AIInsight[]
  /** Set when the group cannot be computed at all yet. */
  readonly unavailable: readonly CapabilityId[]
}

export interface AIInboxState {
  readonly groups: readonly InsightGroupResult[]
  readonly all: readonly AIInsight[]
  readonly openCount: number
  readonly generatedAt: string
}
