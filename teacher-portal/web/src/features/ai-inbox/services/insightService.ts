/**
 * Assembles the AI Inbox from computed insights and declared capabilities.
 *
 * The inbox is grouped by what a teacher would do about something, not by which
 * rule fired. A group with no insights and no working source shows the
 * capability it is waiting on — so "Attendance: nothing to report" and
 * "Attendance: not built" are never the same screen.
 */

import type { CapabilityId } from '../../shared/services/capability'
import { byPriority } from '../../shared/types/common'
import {
  INSIGHT_GROUPS,
  type AIInboxState,
  type AIInsight,
  type InsightGroupResult,
  type InsightStatus,
} from '../types/insight'

export interface InsightStatusMap {
  readonly dismissed: ReadonlySet<string>
  readonly accepted: ReadonlySet<string>
}

export const statusOf = (insightId: string, statuses: InsightStatusMap): InsightStatus =>
  statuses.dismissed.has(insightId) ? 'dismissed' : statuses.accepted.has(insightId) ? 'accepted' : 'open'

/**
 * Learning insights that need concept-level evidence — "12 students confuse
 * velocity and speed" — require the knowledge graph and PSV aggregates. They
 * are declared, never approximated from grades.
 */
const GROUP_PARTIAL_CAPABILITIES: Partial<Record<string, readonly CapabilityId[]>> = {
  learning: ['privacy.class-aggregates'],
  performance: ['privacy.class-aggregates'],
}

export function buildInbox(
  insights: readonly AIInsight[],
  statuses: InsightStatusMap,
  options: { readonly includeResolved?: boolean } = {},
): AIInboxState {
  const { includeResolved = false } = options

  const visible = insights.filter(
    (insight) => includeResolved || statusOf(insight.id, statuses) === 'open',
  )

  const groups: InsightGroupResult[] = INSIGHT_GROUPS.map((spec) => {
    const groupInsights = visible
      .filter((insight) => insight.group === spec.id)
      .sort((a, b) => byPriority(a, b) || b.confidence.score - a.confidence.score)

    // A group is "unavailable" when it cannot produce anything at all. Groups
    // that produce some insights but would produce richer ones with a missing
    // service list that service as a partial gap instead.
    const unavailable =
      spec.requires.length > 0
        ? spec.requires
        : groupInsights.length === 0
          ? []
          : (GROUP_PARTIAL_CAPABILITIES[spec.id] ?? [])

    return { spec, insights: groupInsights, unavailable }
  })

  return {
    groups,
    all: visible,
    openCount: visible.filter((insight) => statusOf(insight.id, statuses) === 'open').length,
    generatedAt: new Date().toISOString(),
  }
}

/** Flat, ranked list — used by the dashboard and by the details route. */
export function rankInsights(insights: readonly AIInsight[]): readonly AIInsight[] {
  return [...insights].sort((a, b) => byPriority(a, b) || b.confidence.score - a.confidence.score)
}
