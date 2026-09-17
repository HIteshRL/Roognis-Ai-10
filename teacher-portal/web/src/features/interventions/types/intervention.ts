import type {
  Confidence,
  Evidence,
  Priority,
  Provenance,
  StudentRef,
  SuggestedAction,
} from '../../shared/types/common'

export type RiskCategory =
  | 'requires-immediate-help'
  | 'likely-to-fail'
  | 'needs-motivation'
  | 'inactive'
  | 'high-performer'

export interface RiskCategorySpec {
  readonly id: RiskCategory
  readonly label: string
  readonly icon: string
  readonly description: string
  readonly priority: Priority
}

/** Display order is severity order; the ruleset evaluates in the same order. */
export const RISK_CATEGORIES: readonly RiskCategorySpec[] = [
  {
    id: 'requires-immediate-help',
    label: 'Requires immediate help',
    icon: 'warning',
    description: 'Grades below the intervention floor with enough graded work to be sure.',
    priority: 'critical',
  },
  {
    id: 'likely-to-fail',
    label: 'Likely to fall below passing',
    icon: 'trend',
    description: 'Currently passing or borderline, but the recent trend is downward.',
    priority: 'high',
  },
  {
    id: 'inactive',
    label: 'Inactive',
    icon: 'inbox',
    description: 'No submission activity for two weeks or more, with work outstanding.',
    priority: 'high',
  },
  {
    id: 'needs-motivation',
    label: 'Needs motivation',
    icon: 'spark',
    description: 'Capable on the evidence, but handing work in late or not at all.',
    priority: 'medium',
  },
  {
    id: 'high-performer',
    label: 'Ready for extension',
    icon: 'trend',
    description: 'Consistently high scores; a candidate for harder work.',
    priority: 'low',
  },
]

export const RISK_CATEGORY_BY_ID: ReadonlyMap<RiskCategory, RiskCategorySpec> = new Map(
  RISK_CATEGORIES.map((spec) => [spec.id, spec]),
)

/** Metrics quoted on the row; all are LMS-derived, none is PSV. */
export interface RiskMetrics {
  readonly averagePercent: number | null
  readonly recentAveragePercent: number | null
  readonly earlierAveragePercent: number | null
  readonly missingCount: number
  readonly lateCount: number
  readonly gradedCount: number
  readonly daysSinceActivity: number | null
}

export interface StudentRisk {
  readonly id: string
  readonly student: StudentRef
  readonly category: RiskCategory
  readonly priority: Priority
  /** One sentence, quoting the numbers that triggered the rule. */
  readonly reason: string
  readonly recommendedAction: string
  readonly confidence: Confidence
  readonly evidence: readonly Evidence[]
  readonly actions: readonly SuggestedAction[]
  readonly metrics: RiskMetrics
  readonly provenance: Provenance
}

export interface RiskGroup {
  readonly spec: RiskCategorySpec
  readonly risks: readonly StudentRisk[]
}

export interface InterventionQueue {
  readonly groups: readonly RiskGroup[]
  readonly all: readonly StudentRisk[]
  readonly classroomId: string
  readonly classroomName: string
  /** Statement of the evidence window the queue was computed over. */
  readonly windowLabel: string
  readonly studentCount: number
  readonly generatedAt: string
}
