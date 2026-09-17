/**
 * Promotes AI Inbox insights to dashboard recommendations.
 *
 * A recommendation is not a second kind of intelligence — it is the same
 * insight, carrying the same evidence and provenance, narrowed to one thing the
 * teacher is being asked to do. Keeping them the same object is what makes
 * "accept the recommendation → open the insight → see the evidence" coherent
 * instead of two systems that happen to agree.
 */

import type { AIInsight } from '../../ai-inbox/types/insight'
import { byPriority } from '../../shared/types/common'
import type { Recommendation } from '../types/dashboard'

/** Recommendations shown on the dashboard before "view all" takes over. */
export const DASHBOARD_RECOMMENDATION_LIMIT = 4

export function toRecommendation(insight: AIInsight): Recommendation {
  const primary = insight.actions.find((action) => action.intent === 'primary') ?? null
  const secondary = insight.actions.filter((action) => action !== primary)

  return {
    id: `rec:${insight.id}`,
    insightId: insight.id,
    title: insight.title,
    summary: insight.explanation.split('. ')[0] ?? insight.explanation,
    explanation: insight.explanation,
    method: insight.method,
    priority: insight.priority,
    confidence: insight.confidence,
    evidence: insight.evidence,
    primaryAction: primary,
    secondaryActions: secondary,
    classroomId: insight.classroomId,
    classroomName: insight.classroomName,
    provenance: insight.provenance,
  }
}

/**
 * Rank across classes, then cap. The cap is returned alongside the total so the
 * card can say how many were held back rather than silently truncating.
 */
export function buildRecommendations(
  insights: readonly AIInsight[],
  limit: number = DASHBOARD_RECOMMENDATION_LIMIT,
): { readonly items: readonly Recommendation[]; readonly total: number } {
  const ranked = [...insights].sort(
    (a, b) => byPriority(a, b) || b.confidence.score - a.confidence.score,
  )
  return {
    items: ranked.slice(0, limit).map(toRecommendation),
    total: ranked.length,
  }
}
