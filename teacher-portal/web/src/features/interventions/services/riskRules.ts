/**
 * Intervention ruleset — deterministic, versioned, explainable.
 *
 * §13 forbids an LLM anywhere in an intervention path, and §7 requires that a
 * selected action be replayable and able to state its own rationale. Every
 * function here is therefore pure: the same `ClassFacts` always produce the same
 * queue, with no network call and no model in the loop. `RULESET_VERSION` is
 * part of the provenance of every row, so a queue captured today can be
 * explained after the thresholds change.
 *
 * Scope note: these rules read *only* the teacher's own LMS records — grades,
 * submission times, due dates. They do not touch PSV, mastery or affect, which
 * is what keeps this ruleset outside the §13 Layer 5 restriction. Signals that
 * would need learner state are declared as capabilities instead
 * (`privacy.class-aggregates`, `decisions.intervention-queue`) and never
 * approximated here.
 *
 * A student lands in at most one category: rules are evaluated most-severe
 * first and the first match wins, so the queue is a partition of the roster and
 * a teacher never sees the same name twice.
 */

import type { ClassFacts, StudentFacts, StudentTaskFact } from '../../shared/services/classFacts'
import { factsWindowLabel } from '../../shared/services/classFacts'
import { clientProvenance } from '../../shared/services/privacyGuard'
import type { Confidence, Evidence, SuggestedAction } from '../../shared/types/common'
import { byPriority } from '../../shared/types/common'
import {
  RISK_CATEGORIES,
  type InterventionQueue,
  type RiskCategory,
  type RiskGroup,
  type StudentRisk,
} from '../types/intervention'

export const RULESET_VERSION = 'intervention-lms-v1'
export const GATE_VERSION = 'lms-evidence-gate-v1'

/**
 * Thresholds are named and exported so they can be reviewed as policy rather
 * than discovered as magic numbers, and asserted directly in tests.
 */
export const THRESHOLDS = {
  /** At or below this average, a student needs help now. */
  criticalAveragePercent: 40,
  /** Below this, a student is not on track to pass. */
  passingPercent: 55,
  /** A drop of at least this many points counts as a downward trend. */
  significantDropPoints: 12,
  /** Days without a submission before a student counts as inactive. */
  inactivityDays: 14,
  /** Late or missing tasks before a capable student is flagged. */
  slippingTaskCount: 2,
  /** At or above this average, with enough evidence, a student is extended. */
  highPerformerPercent: 85,
  /** Minimum graded tasks before any grade-based claim is made. */
  minGradedForGradeClaim: 2,
  /** Minimum graded tasks before a trend claim is made. */
  minGradedForTrendClaim: 4,
} as const

/* ── Confidence ───────────────────────────────────────────────────────────── */

/**
 * Confidence rises with the amount of evidence and with distance from the
 * threshold — a student 30 points under the floor on 8 tasks is a surer call
 * than one 1 point under on 2. Capped below 1: no finite sample justifies
 * certainty about a child.
 */
function gradeConfidence(sampleSize: number, marginPoints: number, basis: string): Confidence {
  const evidenceTerm = Math.min(0.34, 0.085 * Math.max(0, sampleSize - 1))
  const marginTerm = Math.min(0.16, Math.abs(marginPoints) / 100)
  return {
    score: Math.min(0.95, Math.round((0.45 + evidenceTerm + marginTerm) * 100) / 100),
    sampleSize,
    basis,
  }
}

function activityConfidence(daysSinceActivity: number, outstanding: number): Confidence {
  const dayTerm = Math.min(0.3, (daysSinceActivity - THRESHOLDS.inactivityDays) * 0.015)
  const outstandingTerm = Math.min(0.15, outstanding * 0.05)
  return {
    score: Math.min(0.95, Math.round((0.55 + dayTerm + outstandingTerm) * 100) / 100),
    sampleSize: outstanding,
    basis: `${daysSinceActivity} days since the last submission, ${outstanding} task(s) outstanding`,
  }
}

/* ── Evidence ─────────────────────────────────────────────────────────────── */

const taskEvidence = (facts: StudentFacts, task: StudentTaskFact, label: string, detail: string): Evidence => ({
  id: `${facts.student.studentId}:${task.courseworkId}`,
  label,
  detail,
  observedAt: task.turnedInAt ?? task.dueAt ?? new Date().toISOString(),
  ref: {
    kind: 'coursework',
    id: task.courseworkId,
    classroomId: facts.student.classroomId,
  },
})

/** The graded tasks behind an average, newest first, capped for readability. */
function gradedEvidence(facts: StudentFacts, limit = 5): Evidence[] {
  return facts.tasks
    .filter((task) => task.percent !== null)
    .slice(0, limit)
    .map((task) =>
      taskEvidence(
        facts,
        task,
        task.title,
        `Scored ${task.grade}/${task.maxPoints} (${task.percent}%)`,
      ),
    )
}

function missingEvidence(facts: StudentFacts, limit = 5): Evidence[] {
  return facts.tasks
    .filter((task) => task.isMissing)
    .slice(0, limit)
    .map((task) => taskEvidence(facts, task, task.title, 'Past due with no submission'))
}

function lateEvidence(facts: StudentFacts, limit = 5): Evidence[] {
  return facts.tasks
    .filter((task) => task.isLate)
    .slice(0, limit)
    .map((task) => taskEvidence(facts, task, task.title, 'Turned in after the due date'))
}

/* ── Actions ──────────────────────────────────────────────────────────────── */

function actionsFor(category: RiskCategory, facts: StudentFacts): SuggestedAction[] {
  const student = facts.student
  const params: Readonly<Record<string, string>> = {
    studentId: student.studentId,
    studentName: student.name,
    classroomId: student.classroomId ?? '',
  }

  const viewWork: SuggestedAction = {
    id: `${student.studentId}:view-work`,
    label: 'View work',
    kind: 'open-student',
    intent: 'secondary',
    params,
  }

  switch (category) {
    case 'requires-immediate-help':
      return [
        {
          id: `${student.studentId}:revision`,
          label: 'Schedule revision',
          kind: 'schedule-revision',
          intent: 'primary',
          params,
        },
        {
          id: `${student.studentId}:guardian`,
          label: 'Contact guardian',
          kind: 'message-guardian',
          intent: 'secondary',
          params,
        },
        viewWork,
      ]
    case 'likely-to-fail':
      return [
        {
          id: `${student.studentId}:practice`,
          label: 'Assign practice',
          kind: 'create-assignment',
          intent: 'primary',
          params,
        },
        viewWork,
      ]
    case 'inactive':
      return [
        {
          id: `${student.studentId}:nudge`,
          label: 'Post a nudge',
          kind: 'post-announcement',
          intent: 'primary',
          params,
        },
        {
          id: `${student.studentId}:guardian`,
          label: 'Contact guardian',
          kind: 'message-guardian',
          intent: 'secondary',
          params,
        },
      ]
    case 'needs-motivation':
      return [
        {
          id: `${student.studentId}:checkin`,
          label: 'Plan a check-in',
          kind: 'schedule-revision',
          intent: 'primary',
          params,
        },
        viewWork,
      ]
    case 'high-performer':
      return [
        {
          id: `${student.studentId}:extend`,
          label: 'Assign extension',
          kind: 'create-assignment',
          intent: 'primary',
          params,
        },
        viewWork,
      ]
    default:
      return [viewWork]
  }
}

/* ── The rules ────────────────────────────────────────────────────────────── */

interface RuleOutcome {
  readonly category: RiskCategory
  readonly reason: string
  readonly recommendedAction: string
  readonly confidence: Confidence
  readonly evidence: readonly Evidence[]
}

type Rule = (facts: StudentFacts) => RuleOutcome | null

const requiresImmediateHelp: Rule = (facts) => {
  const { averagePercent, gradedCount } = facts
  if (
    averagePercent === null ||
    gradedCount < THRESHOLDS.minGradedForGradeClaim ||
    averagePercent > THRESHOLDS.criticalAveragePercent
  ) {
    return null
  }
  return {
    category: 'requires-immediate-help',
    reason: `Averaging ${averagePercent}% across ${gradedCount} graded tasks — at or below the ${THRESHOLDS.criticalAveragePercent}% intervention floor.`,
    recommendedAction: 'Sit with this student before the next assessment; re-teach the weakest task first.',
    confidence: gradeConfidence(
      gradedCount,
      THRESHOLDS.criticalAveragePercent - averagePercent,
      `${gradedCount} graded tasks, ${Math.round(THRESHOLDS.criticalAveragePercent - averagePercent)} points below the floor`,
    ),
    evidence: gradedEvidence(facts),
  }
}

const likelyToFail: Rule = (facts) => {
  const { averagePercent, recentAveragePercent, earlierAveragePercent, gradedCount } = facts
  if (averagePercent === null || gradedCount < THRESHOLDS.minGradedForGradeClaim) return null

  // Below passing on enough evidence.
  if (averagePercent < THRESHOLDS.passingPercent) {
    return {
      category: 'likely-to-fail',
      reason: `Averaging ${averagePercent}% across ${gradedCount} graded tasks — below the ${THRESHOLDS.passingPercent}% pass mark.`,
      recommendedAction: 'Assign targeted practice on the two lowest-scoring tasks.',
      confidence: gradeConfidence(
        gradedCount,
        THRESHOLDS.passingPercent - averagePercent,
        `${gradedCount} graded tasks below the pass mark`,
      ),
      evidence: gradedEvidence(facts),
    }
  }

  // Passing now, but falling fast enough to cross the line.
  const drop =
    recentAveragePercent !== null && earlierAveragePercent !== null
      ? earlierAveragePercent - recentAveragePercent
      : null
  if (
    drop !== null &&
    gradedCount >= THRESHOLDS.minGradedForTrendClaim &&
    drop >= THRESHOLDS.significantDropPoints &&
    recentAveragePercent !== null &&
    recentAveragePercent < THRESHOLDS.passingPercent + 15
  ) {
    return {
      category: 'likely-to-fail',
      reason: `Recent average ${recentAveragePercent}% against ${earlierAveragePercent}% earlier — a ${Math.round(drop)}-point drop over ${gradedCount} graded tasks.`,
      recommendedAction: 'Check what changed around the drop; re-teach the concept introduced then.',
      confidence: gradeConfidence(gradedCount, drop, `${gradedCount} graded tasks, ${Math.round(drop)}-point decline`),
      evidence: gradedEvidence(facts),
    }
  }

  return null
}

const inactive: Rule = (facts) => {
  const { daysSinceActivity, missingCount, assignedCount } = facts
  const outstanding = missingCount

  if (daysSinceActivity !== null && daysSinceActivity >= THRESHOLDS.inactivityDays && outstanding > 0) {
    return {
      category: 'inactive',
      reason: `No submission for ${daysSinceActivity} days, with ${outstanding} task(s) past due and unsubmitted.`,
      recommendedAction: 'Check whether this is access, illness or disengagement before assigning more.',
      confidence: activityConfidence(daysSinceActivity, outstanding),
      evidence: missingEvidence(facts),
    }
  }

  // Never submitted anything, and there was work to submit.
  if (daysSinceActivity === null && assignedCount > 0 && outstanding > 0) {
    return {
      category: 'inactive',
      reason: `No submissions on record, with ${outstanding} task(s) past due.`,
      recommendedAction: 'Confirm the student can reach the classroom before escalating.',
      confidence: {
        score: Math.min(0.9, 0.6 + outstanding * 0.05),
        sampleSize: outstanding,
        basis: `${outstanding} past-due task(s) with no submission on record`,
      },
      evidence: missingEvidence(facts),
    }
  }

  return null
}

const needsMotivation: Rule = (facts) => {
  const { averagePercent, lateCount, missingCount, gradedCount } = facts
  const slipping = lateCount + missingCount
  if (slipping < THRESHOLDS.slippingTaskCount) return null
  if (averagePercent === null || averagePercent < THRESHOLDS.passingPercent) return null

  return {
    category: 'needs-motivation',
    reason: `Averaging ${averagePercent}% when work is handed in, but ${lateCount} late and ${missingCount} missing.`,
    recommendedAction: 'The capability is there; agree a deadline routine rather than re-teaching content.',
    confidence: {
      score: Math.min(0.9, 0.5 + slipping * 0.08),
      sampleSize: slipping,
      basis: `${lateCount} late and ${missingCount} missing task(s) against a ${averagePercent}% average`,
    },
    evidence: [...lateEvidence(facts, 3), ...missingEvidence(facts, 3)],
  }
}

const highPerformer: Rule = (facts) => {
  const { averagePercent, gradedCount, missingCount } = facts
  if (
    averagePercent === null ||
    gradedCount < 3 ||
    averagePercent < THRESHOLDS.highPerformerPercent ||
    missingCount > 0
  ) {
    return null
  }
  return {
    category: 'high-performer',
    reason: `Averaging ${averagePercent}% across ${gradedCount} graded tasks with nothing outstanding.`,
    recommendedAction: 'Offer extension work so the ceiling is the student, not the task.',
    confidence: gradeConfidence(
      gradedCount,
      averagePercent - THRESHOLDS.highPerformerPercent,
      `${gradedCount} graded tasks above ${THRESHOLDS.highPerformerPercent}%`,
    ),
    evidence: gradedEvidence(facts),
  }
}

/** Severity order. The first rule that matches claims the student. */
const RULES: readonly Rule[] = [
  requiresImmediateHelp,
  likelyToFail,
  inactive,
  needsMotivation,
  highPerformer,
]

/* ── Entry points ─────────────────────────────────────────────────────────── */

export function evaluateStudent(facts: StudentFacts): StudentRisk | null {
  for (const rule of RULES) {
    const outcome = rule(facts)
    if (!outcome) continue

    const spec = RISK_CATEGORIES.find((entry) => entry.id === outcome.category)
    if (!spec) continue

    return {
      id: `${outcome.category}:${facts.student.studentId}`,
      student: facts.student,
      category: outcome.category,
      priority: spec.priority,
      reason: outcome.reason,
      recommendedAction: outcome.recommendedAction,
      confidence: outcome.confidence,
      evidence: outcome.evidence,
      actions: actionsFor(outcome.category, facts),
      metrics: {
        averagePercent: facts.averagePercent,
        recentAveragePercent: facts.recentAveragePercent,
        earlierAveragePercent: facts.earlierAveragePercent,
        missingCount: facts.missingCount,
        lateCount: facts.lateCount,
        gradedCount: facts.gradedCount,
        daysSinceActivity: facts.daysSinceActivity,
      },
      provenance: clientProvenance({
        rulesetVersion: RULESET_VERSION,
        gateVersion: GATE_VERSION,
        evidenceIds: outcome.evidence.map((item) => item.id),
      }),
    }
  }
  return null
}

export function buildInterventionQueue(facts: ClassFacts): InterventionQueue {
  const all = facts.students
    .map(evaluateStudent)
    .filter((risk): risk is StudentRisk => risk !== null)
    .sort(
      (a, b) =>
        byPriority(a, b) ||
        b.confidence.score - a.confidence.score ||
        a.student.name.localeCompare(b.student.name),
    )

  const groups: RiskGroup[] = RISK_CATEGORIES.map((spec) => ({
    spec,
    risks: all.filter((risk) => risk.category === spec.id),
  })).filter((group) => group.risks.length > 0)

  return {
    groups,
    all,
    classroomId: facts.classroom.id,
    classroomName: facts.classroom.name,
    windowLabel: factsWindowLabel(facts),
    studentCount: facts.studentCount,
    generatedAt: facts.generatedAt,
  }
}
