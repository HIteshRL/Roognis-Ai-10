import { describe, expect, it } from 'vitest'
import { buildClassFacts } from '../../../shared/services/classFacts'
import {
  NOW,
  gradedRun,
  snapshot,
  student,
} from '../../../shared/services/__tests__/fixtures'
import { RULESET_VERSION, THRESHOLDS, buildInterventionQueue, evaluateStudent } from '../riskRules'

const facts = (percents: readonly number[], options?: Parameters<typeof gradedRun>[2]) => {
  const learner = student('s1', 'Rahul Menon')
  const run = gradedRun('s1', percents, options)
  const built = buildClassFacts(
    snapshot({ students: [learner], coursework: run.coursework, submissions: run.submissions }),
    NOW,
  )
  const studentFacts = built.students[0]
  if (!studentFacts) throw new Error('fixture produced no student')
  return studentFacts
}

describe('evaluateStudent', () => {
  it('flags a student at or below the intervention floor as requiring immediate help', () => {
    const risk = evaluateStudent(facts([30, 35, 28, 32]))
    expect(risk?.category).toBe('requires-immediate-help')
    expect(risk?.priority).toBe('critical')
    expect(risk?.reason).toContain('31.3%')
  })

  it('does not make a grade claim below the minimum sample', () => {
    // A single task scored 20% is under the floor, but one task is not evidence.
    const single = facts([20])
    expect(single.gradedCount).toBe(1)
    expect(single.gradedCount).toBeLessThan(THRESHOLDS.minGradedForGradeClaim)
    expect(evaluateStudent(single)).toBeNull()
  })

  it('flags a below-pass average as likely to fall short', () => {
    const risk = evaluateStudent(facts([50, 48, 52]))
    expect(risk?.category).toBe('likely-to-fail')
    expect(risk?.priority).toBe('high')
  })

  it('flags a downward trend even while the average is still passing', () => {
    // Newest first: recent work is much weaker than earlier work.
    const risk = evaluateStudent(facts([52, 55, 58, 88, 90, 92]))
    expect(risk?.category).toBe('likely-to-fail')
    expect(risk?.reason).toContain('drop')
  })

  it('flags a capable student who is late or missing as needing motivation', () => {
    const risk = evaluateStudent(facts([78, 82, 75, 80], { lateIndices: [0, 1] }))
    expect(risk?.category).toBe('needs-motivation')
    expect(risk?.metrics.lateCount).toBe(2)
  })

  it('flags consistent high scores as ready for extension', () => {
    const risk = evaluateStudent(facts([92, 88, 95, 90]))
    expect(risk?.category).toBe('high-performer')
    expect(risk?.priority).toBe('low')
  })

  it('returns nothing for a solidly mid-range student', () => {
    expect(evaluateStudent(facts([70, 72, 68, 71]))).toBeNull()
  })

  it('flags a student with no submissions and past-due work as inactive', () => {
    const learner = student('s2', 'Ishita Roy')
    const run = gradedRun('s2', [0, 0, 0], { missingIndices: [0, 1, 2] })
    const built = buildClassFacts(
      snapshot({ students: [learner], coursework: run.coursework, submissions: [] }),
      NOW,
    )
    const risk = evaluateStudent(built.students[0]!)
    expect(risk?.category).toBe('inactive')
    expect(risk?.metrics.missingCount).toBe(3)
  })
})

describe('determinism and provenance', () => {
  it('produces an identical result for identical input', () => {
    const input = facts([30, 35, 28, 32])
    const first = evaluateStudent(input)
    const second = evaluateStudent(input)
    expect({ ...first, provenance: null }).toEqual({ ...second, provenance: null })
  })

  it('carries ruleset version, gate version and evidence ids on every risk', () => {
    const risk = evaluateStudent(facts([30, 35, 28, 32]))
    expect(risk?.provenance.rulesetVersion).toBe(RULESET_VERSION)
    expect(risk?.provenance.gateVersion).toBeTruthy()
    expect(risk?.provenance.computedBy).toBe('client-ruleset')
    expect(risk?.provenance.evidenceIds.length).toBeGreaterThan(0)
    expect(risk?.provenance.evidenceIds).toEqual(risk?.evidence.map((item) => item.id))
  })

  it('cites evidence that points at real coursework records', () => {
    const risk = evaluateStudent(facts([30, 35, 28, 32]))
    expect(risk?.evidence.length).toBeGreaterThan(0)
    for (const item of risk?.evidence ?? []) {
      expect(item.ref?.kind).toBe('coursework')
      expect(item.ref?.id).toBeTruthy()
    }
  })

  it('never claims certainty', () => {
    const risk = evaluateStudent(facts([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]))
    expect(risk?.confidence.score).toBeLessThan(1)
    expect(risk?.confidence.score).toBeLessThanOrEqual(0.95)
  })

  it('is more confident with more evidence', () => {
    const few = evaluateStudent(facts([30, 32]))
    const many = evaluateStudent(facts([30, 32, 31, 29, 33, 30]))
    expect(many!.confidence.score).toBeGreaterThan(few!.confidence.score)
  })
})

describe('buildInterventionQueue', () => {
  const build = () => {
    const students = [student('s1', 'Rahul Menon'), student('s2', 'Ishita Roy'), student('s3', 'Dev Patel')]
    const failing = gradedRun('s1', [30, 35, 28, 32])
    const submissions = [
      ...failing.submissions,
      ...gradedRun('s2', [92, 88, 95, 90]).submissions.map((entry) => ({
        ...entry,
        id: `${entry.id}-s2`,
        studentId: 's2',
      })),
      ...gradedRun('s3', [70, 72, 68, 71]).submissions.map((entry) => ({
        ...entry,
        id: `${entry.id}-s3`,
        studentId: 's3',
      })),
    ]
    return buildInterventionQueue(
      buildClassFacts(
        snapshot({ students, coursework: failing.coursework, submissions }),
        NOW,
      ),
    )
  }

  it('places each student in at most one category', () => {
    const queue = build()
    const ids = queue.all.map((risk) => risk.student.studentId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orders the queue by severity', () => {
    const queue = build()
    expect(queue.all[0]?.category).toBe('requires-immediate-help')
    expect(queue.all.at(-1)?.category).toBe('high-performer')
  })

  it('omits students no rule matched', () => {
    const queue = build()
    expect(queue.all.map((risk) => risk.student.studentId)).not.toContain('s3')
  })

  it('states the evidence window it was computed over', () => {
    expect(build().windowLabel).toMatch(/published tasks/)
  })
})
