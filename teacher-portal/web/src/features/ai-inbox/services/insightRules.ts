/**
 * AI Inbox ruleset — deterministic class-pattern detection.
 *
 * "AI-native" here means the system does the noticing, not that a language
 * model does the deciding. §13 puts an absolute bar on LLMs in scoring and
 * intervention paths, so every insight below is arithmetic over LMS records
 * with a stated method, a confidence tied to sample size, and citable evidence.
 * An LLM may later *phrase* one of these (§7 permits that explicitly); it may
 * never originate one.
 *
 * Each rule answers three questions the teacher will ask:
 *   what did you see (`explanation`), how sure are you (`confidence`),
 *   and what are you reading (`evidence`).
 *
 * Insights that would require mastery, misconception or affect data — "12
 * students confuse velocity and speed" — are NOT approximated here. They are
 * declared as `privacy.class-aggregates` on the Learning group and stay
 * unavailable until `services/privacy` exists.
 */

import type { ClassFacts, TaskFacts } from '../../shared/services/classFacts'
import { clientProvenance } from '../../shared/services/privacyGuard'
import type {
  Confidence,
  Evidence,
  Priority,
  StudentRef,
  SuggestedAction,
} from '../../shared/types/common'
import { byPriority } from '../../shared/types/common'
import type { AIInsight, InsightGroupId } from '../types/insight'

export const RULESET_VERSION = 'class-insight-lms-v1'
export const GATE_VERSION = 'lms-aggregate-gate-v1'

export const INSIGHT_THRESHOLDS = {
  /** A task average at or below this is worth re-teaching. */
  weakTaskAveragePercent: 55,
  /** Minimum graded students before a task-level claim is made. */
  minGradedForTaskClaim: 5,
  /** Class-average movement, in points, that counts as a real change. */
  significantClassDeltaPoints: 8,
  /** Completion-rate movement, in percentage points, that counts. */
  significantCompletionDropPoints: 15,
  /** Gap between quiz and assignment averages that indicates miscalibration. */
  quizDifficultyGapPoints: 20,
  /** Days a turned-in submission may sit ungraded before it is flagged. */
  gradingBacklogDays: 7,
  /** Completion below this on a past-due task is a cluster, not a straggler. */
  lowCompletionRatePercent: 70,
  /** Tasks compared on each side of a trend. */
  trendWindow: 3,
} as const

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const round = (value: number): number => Math.round(value * 10) / 10

function sampleConfidence(sampleSize: number, marginPoints: number, basis: string): Confidence {
  const evidenceTerm = Math.min(0.32, 0.045 * Math.max(0, sampleSize - 2))
  const marginTerm = Math.min(0.18, Math.abs(marginPoints) / 90)
  return {
    score: Math.min(0.95, round((0.45 + evidenceTerm + marginTerm) * 100) / 100),
    sampleSize,
    basis,
  }
}

const taskEvidence = (facts: ClassFacts, task: TaskFacts, detail: string): Evidence => ({
  id: `task:${task.coursework.id}`,
  label: task.coursework.title,
  detail,
  observedAt: task.coursework.dueAt ?? task.coursework.publishedAt ?? facts.generatedAt,
  ref: { kind: 'coursework', id: task.coursework.id, classroomId: facts.classroom.id },
})

const openTask = (facts: ClassFacts, task: TaskFacts, label: string): SuggestedAction => ({
  id: `${task.coursework.id}:open`,
  label,
  kind: 'open-coursework',
  intent: 'secondary',
  params: { classroomId: facts.classroom.id, courseworkId: task.coursework.id },
})

const scheduleRevision = (facts: ClassFacts, topic: string): SuggestedAction => ({
  id: `${facts.classroom.id}:revision:${topic}`,
  label: 'Schedule revision',
  kind: 'schedule-revision',
  intent: 'primary',
  params: { classroomId: facts.classroom.id, topic },
})

/** Students who scored below a percentage on a specific task. */
function studentsBelowOn(facts: ClassFacts, courseworkId: string, percent: number): StudentRef[] {
  return facts.students
    .filter((student) => {
      const task = student.tasks.find((entry) => entry.courseworkId === courseworkId)
      return task?.percent !== null && task?.percent !== undefined && task.percent < percent
    })
    .map((student) => student.student)
}

interface Draft {
  readonly id: string
  readonly group: InsightGroupId
  readonly title: string
  readonly explanation: string
  readonly priority: Priority
  readonly confidence: Confidence
  readonly evidence: readonly Evidence[]
  readonly affectedStudents: readonly StudentRef[]
  readonly actions: readonly SuggestedAction[]
  readonly method: string
}

const finalise = (facts: ClassFacts, draft: Draft): AIInsight => ({
  ...draft,
  classroomId: facts.classroom.id,
  classroomName: facts.classroom.name,
  detectedAt: facts.generatedAt,
  provenance: clientProvenance({
    rulesetVersion: RULESET_VERSION,
    gateVersion: GATE_VERSION,
    evidenceIds: draft.evidence.map((item) => item.id),
  }),
})

/* ── Rules ────────────────────────────────────────────────────────────────── */

/** Learning: a specific task the class did not get. */
function weakTasks(facts: ClassFacts): Draft[] {
  return facts.tasks
    .filter(
      (task) =>
        task.averagePercent !== null &&
        task.gradedCount >= INSIGHT_THRESHOLDS.minGradedForTaskClaim &&
        task.averagePercent <= INSIGHT_THRESHOLDS.weakTaskAveragePercent,
    )
    .map((task) => {
      const average = task.averagePercent as number
      const affected = studentsBelowOn(facts, task.coursework.id, INSIGHT_THRESHOLDS.weakTaskAveragePercent)
      const margin = INSIGHT_THRESHOLDS.weakTaskAveragePercent - average
      return {
        id: `weak-task:${task.coursework.id}`,
        group: 'learning' as const,
        title: `Re-teach before moving past “${task.coursework.title}”`,
        explanation: `The class averaged ${average}% on this task — ${round(margin)} points below the ${INSIGHT_THRESHOLDS.weakTaskAveragePercent}% review line. ${affected.length} of ${task.gradedCount} graded students scored under that line.`,
        priority: (average <= 40 ? 'high' : 'medium') as Priority,
        confidence: sampleConfidence(
          task.gradedCount,
          margin,
          `${task.gradedCount} graded submissions on one task`,
        ),
        evidence: [taskEvidence(facts, task, `Class average ${average}% across ${task.gradedCount} graded submissions`)],
        affectedStudents: affected,
        actions: [scheduleRevision(facts, task.coursework.title), openTask(facts, task, 'Open task')],
        method: `Mean of graded percentages on this task, compared against the ${INSIGHT_THRESHOLDS.weakTaskAveragePercent}% review threshold. Requires at least ${INSIGHT_THRESHOLDS.minGradedForTaskClaim} graded submissions.`,
      }
    })
}

/** Performance: is the class average moving? */
function classAverageTrend(facts: ClassFacts): Draft[] {
  const scored = facts.tasks.filter(
    (task) => task.averagePercent !== null && task.gradedCount >= INSIGHT_THRESHOLDS.minGradedForTaskClaim,
  )
  const window = INSIGHT_THRESHOLDS.trendWindow
  if (scored.length < window * 2) return []

  const recent = scored.slice(0, window)
  const earlier = scored.slice(window, window * 2)
  const avg = (tasks: readonly TaskFacts[]): number =>
    round(tasks.reduce((sum, task) => sum + (task.averagePercent as number), 0) / tasks.length)

  const recentAvg = avg(recent)
  const earlierAvg = avg(earlier)
  const delta = round(recentAvg - earlierAvg)
  if (Math.abs(delta) < INSIGHT_THRESHOLDS.significantClassDeltaPoints) return []

  const falling = delta < 0
  const sampleSize = [...recent, ...earlier].reduce((sum, task) => sum + task.gradedCount, 0)

  return [
    {
      id: `class-trend:${facts.classroom.id}`,
      group: 'performance',
      title: falling
        ? `Class average down ${Math.abs(delta)} points`
        : `Class average up ${delta} points`,
      explanation: `The last ${window} graded tasks averaged ${recentAvg}%, against ${earlierAvg}% on the ${window} before them.`,
      priority: falling ? (Math.abs(delta) >= 15 ? 'high' : 'medium') : 'low',
      confidence: sampleConfidence(sampleSize, delta, `${sampleSize} graded submissions across ${window * 2} tasks`),
      evidence: [...recent, ...earlier].map((task) =>
        taskEvidence(facts, task, `Task average ${task.averagePercent}% (${task.gradedCount} graded)`),
      ),
      affectedStudents: [],
      actions: falling
        ? [scheduleRevision(facts, 'recent chapters')]
        : [
            {
              id: `${facts.classroom.id}:share-progress`,
              label: 'Tell the class',
              kind: 'post-announcement',
              intent: 'primary',
              params: { classroomId: facts.classroom.id },
            },
          ],
      method: `Mean task average over the most recent ${window} graded tasks minus the mean over the ${window} preceding, flagged past ±${INSIGHT_THRESHOLDS.significantClassDeltaPoints} points.`,
    },
  ]
}

/** Behaviour: is homework completion falling? */
function completionTrend(facts: ClassFacts): Draft[] {
  const dated = facts.tasks.filter((task) => task.isPastDue && task.completionRate !== null)
  const window = INSIGHT_THRESHOLDS.trendWindow
  if (dated.length < window * 2) return []

  const recent = dated.slice(0, window)
  const earlier = dated.slice(window, window * 2)
  const avg = (tasks: readonly TaskFacts[]): number =>
    round(tasks.reduce((sum, task) => sum + (task.completionRate as number), 0) / tasks.length)

  const recentRate = avg(recent)
  const earlierRate = avg(earlier)
  const drop = round(earlierRate - recentRate)
  if (drop < INSIGHT_THRESHOLDS.significantCompletionDropPoints) return []

  return [
    {
      id: `completion-drop:${facts.classroom.id}`,
      group: 'behaviour',
      title: `Homework completion dropped ${drop} points`,
      explanation: `The last ${window} due tasks were completed by ${recentRate}% of the class, against ${earlierRate}% on the ${window} before them.`,
      priority: drop >= 25 ? 'high' : 'medium',
      confidence: sampleConfidence(
        facts.studentCount * window,
        drop,
        `${window * 2} past-due tasks across ${facts.studentCount} students`,
      ),
      evidence: [...recent, ...earlier].map((task) =>
        taskEvidence(facts, task, `${task.submittedCount}/${task.assignedCount} turned in (${task.completionRate}%)`),
      ),
      affectedStudents: [],
      actions: [
        {
          id: `${facts.classroom.id}:deadline-reset`,
          label: 'Post a deadline reminder',
          kind: 'post-announcement',
          intent: 'primary',
          params: { classroomId: facts.classroom.id },
        },
      ],
      method: `Mean completion rate over the most recent ${window} past-due tasks minus the mean over the ${window} preceding, flagged past ${INSIGHT_THRESHOLDS.significantCompletionDropPoints} points.`,
    },
  ]
}

/** Curriculum: quizzes materially harder than assignments. */
function quizCalibration(facts: ClassFacts): Draft[] {
  const gradedTasks = facts.tasks.filter(
    (task) => task.averagePercent !== null && task.gradedCount >= INSIGHT_THRESHOLDS.minGradedForTaskClaim,
  )
  const quizzes = gradedTasks.filter((task) => task.coursework.type === 'quiz')
  const assignments = gradedTasks.filter((task) => task.coursework.type === 'assignment')
  if (quizzes.length < 2 || assignments.length < 2) return []

  const avg = (tasks: readonly TaskFacts[]): number =>
    round(tasks.reduce((sum, task) => sum + (task.averagePercent as number), 0) / tasks.length)
  const quizAvg = avg(quizzes)
  const assignmentAvg = avg(assignments)
  const gap = round(assignmentAvg - quizAvg)
  if (gap < INSIGHT_THRESHOLDS.quizDifficultyGapPoints) return []

  const sampleSize = [...quizzes, ...assignments].reduce((sum, task) => sum + task.gradedCount, 0)

  return [
    {
      id: `quiz-calibration:${facts.classroom.id}`,
      group: 'curriculum',
      title: 'Quiz difficulty is out of step with assignments',
      explanation: `Quizzes average ${quizAvg}% while assignments average ${assignmentAvg}% — a ${gap}-point gap across ${quizzes.length} quizzes and ${assignments.length} assignments. Either the quizzes test something the assignments do not, or they are simply harder.`,
      priority: 'medium',
      confidence: sampleConfidence(sampleSize, gap, `${sampleSize} graded submissions across both task types`),
      evidence: [...quizzes, ...assignments].map((task) =>
        taskEvidence(facts, task, `${task.coursework.type} · average ${task.averagePercent}%`),
      ),
      affectedStudents: [],
      actions: [
        {
          id: `${facts.classroom.id}:review-quiz`,
          label: 'Review quiz items',
          kind: 'create-quiz',
          intent: 'primary',
          params: { classroomId: facts.classroom.id },
        },
      ],
      method: `Mean quiz average subtracted from mean assignment average, flagged past ${INSIGHT_THRESHOLDS.quizDifficultyGapPoints} points. Requires at least 2 tasks of each type.`,
    },
  ]
}

/** Urgency: work turned in and left ungraded. */
function gradingBacklog(facts: ClassFacts): Draft[] {
  const stale = facts.tasks.filter(
    (task) =>
      task.awaitingFeedbackCount > 0 &&
      task.daysPastDue !== null &&
      task.daysPastDue >= INSIGHT_THRESHOLDS.gradingBacklogDays,
  )
  if (stale.length === 0) return []

  const total = stale.reduce((sum, task) => sum + task.awaitingFeedbackCount, 0)
  const oldest = Math.max(...stale.map((task) => task.daysPastDue ?? 0))

  return [
    {
      id: `grading-backlog:${facts.classroom.id}`,
      group: 'urgency',
      title: `${total} submission${total === 1 ? '' : 's'} waiting on feedback`,
      explanation: `Across ${stale.length} task${stale.length === 1 ? '' : 's'}, ${total} turned-in submission${total === 1 ? ' is' : 's are'} still ungraded. The oldest closed ${oldest} days ago — feedback after this long stops changing what a student does next.`,
      priority: oldest >= 14 ? 'high' : 'medium',
      confidence: {
        score: 0.95,
        sampleSize: total,
        basis: 'Counted directly from submission records — not an estimate',
      },
      evidence: stale.map((task) =>
        taskEvidence(facts, task, `${task.awaitingFeedbackCount} awaiting feedback, due ${task.daysPastDue} days ago`),
      ),
      affectedStudents: [],
      actions: stale.slice(0, 3).map((task) => ({
        id: `${task.coursework.id}:grade`,
        label: `Grade “${task.coursework.title}”`,
        kind: 'grade-submissions' as const,
        intent: 'primary' as const,
        params: { classroomId: facts.classroom.id, courseworkId: task.coursework.id },
      })),
      method: `Turned-in count minus graded count per task, restricted to tasks whose due date passed at least ${INSIGHT_THRESHOLDS.gradingBacklogDays} days ago.`,
    },
  ]
}

/** Behaviour: a past-due task a large share of the class simply did not do. */
function missingClusters(facts: ClassFacts): Draft[] {
  return facts.tasks
    .filter(
      (task) =>
        task.isPastDue &&
        task.completionRate !== null &&
        task.completionRate < INSIGHT_THRESHOLDS.lowCompletionRatePercent &&
        task.assignedCount >= INSIGHT_THRESHOLDS.minGradedForTaskClaim,
    )
    .map((task) => {
      const rate = task.completionRate as number
      const missing = task.assignedCount - task.submittedCount
      const affected = facts.students
        .filter((student) =>
          student.tasks.some((entry) => entry.courseworkId === task.coursework.id && entry.isMissing),
        )
        .map((student) => student.student)

      return {
        id: `missing-cluster:${task.coursework.id}`,
        group: 'behaviour' as const,
        title: `${missing} students did not submit “${task.coursework.title}”`,
        explanation: `Only ${rate}% of the class turned this in, ${task.daysPastDue} days after it was due. A gap this size is usually the task, not the students — check whether the brief or the timing was the problem.`,
        priority: (rate < 50 ? 'high' : 'medium') as Priority,
        confidence: sampleConfidence(
          task.assignedCount,
          INSIGHT_THRESHOLDS.lowCompletionRatePercent - rate,
          `${task.assignedCount} students assigned`,
        ),
        evidence: [taskEvidence(facts, task, `${task.submittedCount}/${task.assignedCount} turned in (${rate}%)`)],
        affectedStudents: affected,
        actions: [
          openTask(facts, task, 'Open task'),
          {
            id: `${task.coursework.id}:remind`,
            label: 'Post a reminder',
            kind: 'post-announcement',
            intent: 'primary',
            params: { classroomId: facts.classroom.id, courseworkId: task.coursework.id },
          },
        ],
        method: `Turned-in count over assigned count on past-due tasks, flagged below ${INSIGHT_THRESHOLDS.lowCompletionRatePercent}%.`,
      }
    })
}

const RULES: readonly ((facts: ClassFacts) => Draft[])[] = [
  gradingBacklog,
  weakTasks,
  missingClusters,
  classAverageTrend,
  completionTrend,
  quizCalibration,
]

/** Run every rule over one class and return the insights, most urgent first. */
export function buildInsights(facts: ClassFacts): AIInsight[] {
  return RULES.flatMap((rule) => rule(facts))
    .map((draft) => finalise(facts, draft))
    .sort((a, b) => byPriority(a, b) || b.confidence.score - a.confidence.score)
}
