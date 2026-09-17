import { describe, expect, it, vi } from 'vitest'

// The guard's whole purpose is to fail closed on payloads it should never
// receive, so the transport is mocked and the assertions are about refusal.
vi.mock('../../../../api/client', () => {
  class ApiError extends Error {
    status: number
    data: unknown
    constructor(message: string, status: number, data: unknown) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.data = data
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } }
})

import { ApiError, api } from '../../../../api/client'
import {
  CohortTooSmallError,
  MIN_COHORT_SIZE,
  PrivacyViolationError,
  assertNoRestrictedConstructs,
  clientProvenance,
  guardAggregate,
} from '../privacyGuard'

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>

describe('restricted construct scanning (§12)', () => {
  it('allows academic fields', () => {
    expect(() =>
      assertNoRestrictedConstructs({
        masteryBand: 'developing',
        conceptId: 'equivalent_fractions',
        attempts: 4,
        students: [{ name: 'Rahul', averagePercent: 62 }],
      }),
    ).not.toThrow()
  })

  it.each([
    ['affectState', { affectState: 'frustrated' }],
    ['mood', { mood: 3 }],
    ['anxietyScore', { anxietyScore: 0.8 }],
    ['adhd_flag', { adhd_flag: true }],
    ['mental-health', { 'mental-health': 'at risk' }],
    ['clinicalNote', { clinicalNote: 'referred' }],
    ['frustration_level', { frustration_level: 2 }],
  ])('rejects a payload carrying %s', (_label, payload) => {
    expect(() => assertNoRestrictedConstructs(payload)).toThrow(PrivacyViolationError)
  })

  it('finds a restricted construct nested inside arrays and objects', () => {
    const payload = { classes: [{ students: [{ id: 'a', sentimentScore: 0.2 }] }] }
    expect(() => assertNoRestrictedConstructs(payload)).toThrow(PrivacyViolationError)
  })

  it('names the offending path so the producing service can be fixed', () => {
    try {
      assertNoRestrictedConstructs({ cohort: { summary: { moodTrend: 'down' } } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PrivacyViolationError)
      expect((error as PrivacyViolationError).path).toBe('$.cohort.summary.moodTrend')
    }
  })

  it('ignores primitives and nulls', () => {
    expect(() => assertNoRestrictedConstructs(null)).not.toThrow()
    expect(() => assertNoRestrictedConstructs('mood')).not.toThrow()
    expect(() => assertNoRestrictedConstructs(42)).not.toThrow()
  })
})

describe('guardAggregate', () => {
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    data: { weakConcepts: [{ conceptId: 'photosynthesis', belowThreshold: 8 }] },
    cohortSize: 24,
    provenance: {
      source: 'psv-aggregate',
      rulesetVersion: 'psv-v1',
      gateVersion: 'privacy-v1',
      computedAt: '2026-07-29T09:00:00.000Z',
      computedBy: 'privacy-guard',
      evidenceIds: ['e1'],
    },
    ...overrides,
  })

  it('reports the capability as unprovisioned when the service is absent', async () => {
    mockGet.mockRejectedValueOnce(new ApiError('not found', 404, null))
    const result = await guardAggregate('classroom-mastery', 'class-1')
    expect(result.kind).toBe('unprovisioned')
    if (result.kind === 'unprovisioned') {
      expect(result.capability.service).toBe('services/privacy')
      expect(result.capability.reason).toBe('blocked')
    }
  })

  it('passes a well-formed aggregate through with its provenance', async () => {
    mockGet.mockResolvedValueOnce(envelope())
    const result = await guardAggregate('classroom-mastery', 'class-1')
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.data.provenance.gateVersion).toBe('privacy-v1')
    }
  })

  it('suppresses an aggregate computed over too few learners', async () => {
    mockGet.mockResolvedValueOnce(envelope({ cohortSize: MIN_COHORT_SIZE - 1 }))
    const result = await guardAggregate('classroom-mastery', 'class-1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.error).toBeInstanceOf(CohortTooSmallError)
  })

  it('refuses an aggregate that arrives without provenance', async () => {
    mockGet.mockResolvedValueOnce(envelope({ provenance: undefined }))
    const result = await guardAggregate('classroom-mastery', 'class-1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.error.message).toContain('provenance')
  })

  it('refuses an aggregate carrying a restricted construct', async () => {
    mockGet.mockResolvedValueOnce(envelope({ data: { cohortMoodIndex: 0.3 } }))
    const result = await guardAggregate('classroom-mastery', 'class-1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.error).toBeInstanceOf(PrivacyViolationError)
  })

  it('never throws, so a missing Layer 5 service degrades one panel', async () => {
    mockGet.mockRejectedValueOnce(new Error('network down'))
    await expect(guardAggregate('classroom-mastery', 'class-1')).resolves.toMatchObject({
      kind: 'error',
    })
  })
})

describe('clientProvenance', () => {
  it('marks client rulesets as such so they are distinguishable in logs', () => {
    const provenance = clientProvenance({
      rulesetVersion: 'r-v1',
      gateVersion: 'g-v1',
      evidenceIds: ['a', 'b'],
    })
    expect(provenance.computedBy).toBe('client-ruleset')
    expect(provenance.source).toBe('lms-coursework')
    expect(provenance.evidenceIds).toEqual(['a', 'b'])
  })
})
