/**
 * Privacy Guard — client half.
 *
 * `ARCHITECTUREDesign.md` §13 forbids any teacher or parent view derived from
 * PSV before `services/privacy` exists, and §7 states that teacher insight is
 * "aggregate, privacy-filtered class patterns; never raw student PSV". That
 * service is a Layer 5 deliverable and does not exist yet.
 *
 * This module is the frontend's enforcement of that boundary. Every read of
 * learner-derived data in the Command Center, the AI Inbox and the intervention
 * queue goes through here — there is no second path. It does four things:
 *
 *  1. Classifies a request as roster-scoped (LMS data the teacher already owns:
 *     coursework, submissions, grades) or PSV-derived (mastery, calibration,
 *     affect). PSV-derived reads are routed to `services/privacy` and report as
 *     unprovisioned until that service ships.
 *  2. Rejects any payload carrying a restricted construct (§12: no clinical or
 *     affect labels reach a teacher surface), even if a backend later emits one
 *     by mistake. Fail closed, loudly.
 *  3. Enforces a minimum cohort size on aggregates so a "class pattern" cannot
 *     be read back as a statement about one identifiable child.
 *  4. Requires §6.2 provenance — evidence ids, ruleset version, gate version —
 *     on everything it returns.
 *
 * When `services/privacy` lands, only `PSV_ENDPOINTS` and `guardAggregate`
 * change. No component, hook or ruleset is touched.
 */

import { api, ApiError } from '../../../api/client'
import type { Provenance } from '../types/common'
import {
  type CapabilityId,
  type CapabilityState,
  capabilityError,
  isUnimplemented,
  ready,
  unprovisioned,
} from './capability'

/* ── §12: constructs that must never reach a teacher surface ──────────────── */

/**
 * Normalised substrings. A payload key matching any of these is treated as a
 * contract violation by whatever produced it, not as data to render.
 */
const RESTRICTED_CONSTRUCTS: readonly string[] = [
  'affect',
  'mood',
  'emotion',
  'sentiment',
  'anxiety',
  'depress',
  'adhd',
  'attentiondisorder',
  'mentalhealth',
  'diagnosis',
  'clinical',
  'psychiatric',
  'wellbeingscore',
  'frustrationlevel',
  'stresslevel',
]

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_\-\s]/g, '')

export class PrivacyViolationError extends Error {
  readonly path: string
  readonly construct: string
  constructor(path: string, construct: string) {
    super(
      `Privacy Guard blocked a response: field "${path}" matches the restricted construct ` +
        `"${construct}". ARCHITECTUREDesign.md §12 forbids clinical or affect labels on ` +
        `teacher surfaces. This is a backend contract violation.`,
    )
    this.name = 'PrivacyViolationError'
    this.path = path
    this.construct = construct
  }
}

export class CohortTooSmallError extends Error {
  readonly cohortSize: number
  constructor(cohortSize: number, minimum: number) {
    super(
      `Privacy Guard suppressed an aggregate computed over ${cohortSize} learners ` +
        `(minimum ${minimum}). Below this size a class aggregate identifies individuals.`,
    )
    this.name = 'CohortTooSmallError'
    this.cohortSize = cohortSize
  }
}

/**
 * Depth-first scan for restricted constructs. Runs on every guarded payload;
 * responses are small (class-scoped aggregates), so the cost is negligible
 * against the cost of leaking a clinical label to a teacher.
 */
export function assertNoRestrictedConstructs(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRestrictedConstructs(entry, `${path}[${index}]`))
    return
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalised = normaliseKey(key)
    const hit = RESTRICTED_CONSTRUCTS.find((construct) => normalised.includes(construct))
    if (hit) throw new PrivacyViolationError(`${path}.${key}`, hit)
    assertNoRestrictedConstructs(entry, `${path}.${key}`)
  }
}

/* ── Aggregate disclosure control ─────────────────────────────────────────── */

/**
 * Smallest cohort a class-level aggregate may describe. Five keeps "8 students
 * misunderstood photosynthesis" a pattern rather than a roster.
 */
export const MIN_COHORT_SIZE = 5

/* ── Endpoint map ─────────────────────────────────────────────────────────── */

/**
 * PSV-derived reads and the capability that gates each one. These endpoints do
 * not exist yet; the guard reports them as unprovisioned rather than calling
 * something speculative.
 */
const PSV_ENDPOINTS: Readonly<Record<string, CapabilityId>> = {
  'classroom-mastery': 'privacy.class-aggregates',
  'concept-confusion': 'privacy.class-aggregates',
  'predicted-performance': 'privacy.class-aggregates',
  'disengagement-signals': 'privacy.class-aggregates',
  'intervention-queue': 'decisions.intervention-queue',
  recommendations: 'decisions.recommendations',
}

export type PsvAggregateKey = keyof typeof PSV_ENDPOINTS

/** A guarded payload: data plus the provenance that justifies showing it. */
export interface Guarded<T> {
  readonly data: T
  readonly provenance: Provenance
}

/**
 * Read a PSV-derived class aggregate.
 *
 * Always resolves — never throws — so a missing Layer 5 service degrades a
 * panel instead of breaking a page. Returns `unprovisioned` until
 * `services/privacy` and `services/decisions` exist.
 */
export async function guardAggregate<T>(
  key: PsvAggregateKey,
  classroomId: string,
): Promise<CapabilityState<Guarded<T>>> {
  const capabilityId = PSV_ENDPOINTS[key]
  if (!capabilityId) {
    return capabilityError(new Error(`Unknown aggregate "${String(key)}"`))
  }

  try {
    const response = await api.get<unknown>(
      `/privacy/classrooms/${encodeURIComponent(classroomId)}/aggregates/${String(key)}`,
    )

    assertNoRestrictedConstructs(response)

    const envelope = response as {
      data?: T
      provenance?: Provenance
      cohortSize?: number
    }

    if (!envelope || typeof envelope !== 'object' || envelope.data === undefined) {
      return capabilityError(
        new Error(`Privacy Guard returned no data envelope for aggregate "${String(key)}".`),
      )
    }

    const cohortSize = envelope.cohortSize ?? 0
    if (cohortSize < MIN_COHORT_SIZE) {
      return capabilityError(new CohortTooSmallError(cohortSize, MIN_COHORT_SIZE))
    }

    if (!envelope.provenance || !envelope.provenance.gateVersion) {
      return capabilityError(
        new Error(
          `Aggregate "${String(key)}" arrived without §6.2 provenance (gate version, ruleset ` +
            `version, evidence ids). Refusing to display an unattributable insight.`,
        ),
      )
    }

    return ready({ data: envelope.data, provenance: envelope.provenance })
  } catch (error) {
    if (error instanceof PrivacyViolationError) return capabilityError(error)
    if (error instanceof ApiError && isUnimplemented(error.status)) {
      return unprovisioned(capabilityId)
    }
    return capabilityError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Read roster-scoped LMS data (coursework, submissions, grades, announcements).
 *
 * This is data the teacher already owns and can see in the gradebook, so it is
 * not PSV and not gated by Layer 5. It still passes the §12 construct scan,
 * because that check is about what a *response* contains, not where it came
 * from — an LMS endpoint that started returning an affect label would be caught
 * here too.
 */
export async function guardRoster<T>(path: string): Promise<T> {
  const response = await api.get<T>(path)
  assertNoRestrictedConstructs(response)
  return response
}

/** Provenance stamp for a client-side deterministic ruleset (§6.2, §7). */
export function clientProvenance(args: {
  rulesetVersion: string
  gateVersion: string
  evidenceIds: readonly string[]
  source?: Provenance['source']
}): Provenance {
  return {
    source: args.source ?? 'lms-coursework',
    rulesetVersion: args.rulesetVersion,
    gateVersion: args.gateVersion,
    computedAt: new Date().toISOString(),
    computedBy: 'client-ruleset',
    evidenceIds: args.evidenceIds,
  }
}
