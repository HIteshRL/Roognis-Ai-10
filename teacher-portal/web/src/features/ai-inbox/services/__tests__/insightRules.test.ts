import { describe, expect, it } from 'vitest'
import { buildClassFacts } from '../../../shared/services/classFacts'
import {
  NOW,
  coursework,
  daysAgo,
  snapshot,
  student,
  submission,
} from '../../../shared/services/__tests__/fixtures'
import { INSIGHT_THRESHOLDS, RULESET_VERSION, buildInsights } from '../insightRules'

const ROSTER = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, index) =>
  student(id, `Student ${index + 1}`),
)

/** One task, scored for every student in the roster. */
function task(id: string, percents: readonly number[], overrides: Partial<Parameters<typeof coursework>[0]> = {}) {
  const work = coursework({ id, ...overrides })
  const submissions = percents.map((percent, index) =>
    submission({
      id: `${id}-sub-${index}`,
      courseworkId: id,
      studentId: ROSTER[index]!.studentId,
      grade: percent,
    }),
  )
  return { work, submissions }
}

const factsFor = (tasks: readonly ReturnType<typeof task>[]) =>
  buildClassFacts(
    snapshot({
      students: ROSTER,
      coursework: tasks.map((entry) => entry.work),
      submissions: tasks.flatMap((entry) => entry.submissions),
    }),
    NOW,
  )

describe('weak task detection', () => {
  it('flags a task the class averaged below the review line', () => {
    const insights = buildInsights(factsFor([task('cw-1', [40, 45, 38, 50, 42, 44])]))
    const weak = insights.find((insight) => insight.id === 'weak-task:cw-1')
    expect(weak).toBeDefined()
    expect(weak?.group).toBe('learning')
    expect(weak?.explanation).toContain('%')
    expect(weak?.affectedStudents.length).toBeGreaterThan(0)
  })

  it('stays silent when the class did fine', () => {
    const insights = buildInsights(factsFor([task('cw-1', [80, 85, 78, 82, 88, 79])]))
    expect(insights.find((insight) => insight.id === 'weak-task:cw-1')).toBeUndefined()
  })

  it('refuses a task-level claim below the minimum graded sample', () => {
    const insights = buildInsights(factsFor([task('cw-1', [10, 12])]))
    expect(insights.find((insight) => insight.id === 'weak-task:cw-1')).toBeUndefined()
    expect(INSIGHT_THRESHOLDS.minGradedForTaskClaim).toBe(5)
  })
})

describe('class trend detection', () => {
  const declining = () =>
    factsFor([
      task('cw-1', [55, 52, 58, 54, 56, 53], { dueAt: daysAgo(2) }),
      task('cw-2', [56, 54, 55, 57, 53, 55], { dueAt: daysAgo(6) }),
      task('cw-3', [54, 56, 53, 55, 57, 54], { dueAt: daysAgo(10) }),
      task('cw-4', [80, 82, 78, 81, 79, 83], { dueAt: daysAgo(14) }),
      task('cw-5', [81, 79, 82, 80, 78, 81], { dueAt: daysAgo(18) }),
      task('cw-6', [79, 81, 80, 82, 78, 80], { dueAt: daysAgo(22) }),
    ])

  it('reports a falling class average with both figures', () => {
    const trend = buildInsights(declining()).find((insight) =>
      insight.id.startsWith('class-trend:'),
    )
    expect(trend).toBeDefined()
    expect(trend?.group).toBe('performance')
    expect(trend?.title).toContain('down')
    expect(trend?.evidence.length).toBe(INSIGHT_THRESHOLDS.trendWindow * 2)
  })

  it('stays silent when movement is inside the noise band', () => {
    const flat = factsFor([
      task('cw-1', [70, 72, 68, 71, 69, 70], { dueAt: daysAgo(2) }),
      task('cw-2', [71, 69, 70, 72, 68, 71], { dueAt: daysAgo(6) }),
      task('cw-3', [69, 71, 72, 68, 70, 71], { dueAt: daysAgo(10) }),
      task('cw-4', [72, 70, 69, 71, 70, 68], { dueAt: daysAgo(14) }),
      task('cw-5', [70, 71, 69, 70, 72, 69], { dueAt: daysAgo(18) }),
      task('cw-6', [71, 70, 70, 69, 71, 70], { dueAt: daysAgo(22) }),
    ])
    expect(buildInsights(flat).find((insight) => insight.id.startsWith('class-trend:'))).toBeUndefined()
  })
})

describe('quiz calibration', () => {
  it('flags quizzes that run far below assignments', () => {
    const insights = buildInsights(
      factsFor([
        task('q-1', [40, 42, 38, 41, 39, 43], { type: 'quiz', dueAt: daysAgo(3) }),
        task('q-2', [41, 39, 42, 40, 38, 41], { type: 'quiz', dueAt: daysAgo(7) }),
        task('a-1', [78, 80, 76, 79, 81, 77], { type: 'assignment', dueAt: daysAgo(11) }),
        task('a-2', [80, 78, 79, 81, 77, 80], { type: 'assignment', dueAt: daysAgo(15) }),
      ]),
    )
    const calibration = insights.find((insight) => insight.id.startsWith('quiz-calibration:'))
    expect(calibration).toBeDefined()
    expect(calibration?.group).toBe('curriculum')
  })
})

describe('grading backlog', () => {
  /**
   * The LMS reports `turnedIn` as status `turned_in` and `graded` as status
   * `returned`, and grading only sets `returned` when the teacher returns the
   * work. So "submitted" is the sum, and "awaiting feedback" is `turnedIn`
   * alone. Reading `turnedIn` as "submitted" made fully graded tasks look
   * unsubmitted — these assertions pin the correct reading down.
   */
  it('counts work submitted but not yet returned to the student', () => {
    const work = coursework({
      id: 'cw-late',
      dueAt: daysAgo(INSIGHT_THRESHOLDS.gradingBacklogDays + 3),
      submissionStats: { assignedCount: 6, turnedIn: 5, graded: 1, gradedNotReturned: 0, missing: 0 },
    })
    const facts = buildClassFacts(
      snapshot({ students: ROSTER, coursework: [work], submissions: [] }),
      NOW,
    )

    expect(facts.tasks[0]?.submittedCount).toBe(6)
    expect(facts.tasks[0]?.awaitingFeedbackCount).toBe(5)
    expect(facts.tasks[0]?.completionRate).toBe(100)

    const backlog = buildInsights(facts).find((insight) => insight.id.startsWith('grading-backlog:'))
    expect(backlog).toBeDefined()
    expect(backlog?.group).toBe('urgency')
    expect(backlog?.title).toContain('5')
    expect(backlog?.confidence.score).toBeGreaterThan(0.9)
  })

  it('does not treat a fully returned task as a backlog', () => {
    const work = coursework({
      id: 'cw-done',
      dueAt: daysAgo(INSIGHT_THRESHOLDS.gradingBacklogDays + 3),
      submissionStats: { assignedCount: 6, turnedIn: 0, graded: 6, gradedNotReturned: 0, missing: 0 },
    })
    const facts = buildClassFacts(
      snapshot({ students: ROSTER, coursework: [work], submissions: [] }),
      NOW,
    )
    expect(facts.tasks[0]?.completionRate).toBe(100)
    expect(buildInsights(facts).find((insight) => insight.id.startsWith('grading-backlog:'))).toBeUndefined()
    // …and certainly not a missing cluster, which is what the old reading gave.
    expect(buildInsights(facts).find((insight) => insight.id.startsWith('missing-cluster:'))).toBeUndefined()
  })
})

describe('missing clusters', () => {
  it('flags a past-due task most of the class skipped', () => {
    const work = coursework({ id: 'cw-skipped', dueAt: daysAgo(4) })
    // Only two of six submitted, and both were returned.
    const submissions = ROSTER.slice(0, 2).map((entry, index) =>
      submission({
        id: `cw-skipped-sub-${index}`,
        courseworkId: 'cw-skipped',
        studentId: entry.studentId,
        grade: 70,
      }),
    )
    const facts = buildClassFacts(snapshot({ students: ROSTER, coursework: [work], submissions }), NOW)

    expect(facts.tasks[0]?.submittedCount).toBe(2)
    expect(facts.tasks[0]?.completionRate).toBeCloseTo(33.3, 1)

    const cluster = buildInsights(facts).find((insight) => insight.id === 'missing-cluster:cw-skipped')
    expect(cluster).toBeDefined()
    expect(cluster?.group).toBe('behaviour')
    expect(cluster?.title).toContain('4')
    expect(cluster?.affectedStudents.length).toBe(4)
  })
})

describe('contract', () => {
  const insights = () => buildInsights(factsFor([task('cw-1', [40, 45, 38, 50, 42, 44])]))

  it('stamps every insight with ruleset and gate versions and evidence ids', () => {
    for (const insight of insights()) {
      expect(insight.provenance.rulesetVersion).toBe(RULESET_VERSION)
      expect(insight.provenance.gateVersion).toBeTruthy()
      expect(insight.provenance.computedBy).toBe('client-ruleset')
      expect(insight.provenance.evidenceIds).toEqual(insight.evidence.map((item) => item.id))
    }
  })

  it('states the method behind every insight', () => {
    for (const insight of insights()) expect(insight.method.length).toBeGreaterThan(20)
  })

  it('never claims certainty', () => {
    for (const insight of insights()) expect(insight.confidence.score).toBeLessThanOrEqual(0.95)
  })

  it('is deterministic', () => {
    const strip = (list: ReturnType<typeof insights>) =>
      list.map((insight) => ({ ...insight, provenance: null, detectedAt: null }))
    expect(strip(insights())).toEqual(strip(insights()))
  })
})
