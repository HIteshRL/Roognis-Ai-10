/**
 * Backend capability registry.
 *
 * Some surfaces in the Command Center depend on services that the architecture
 * schedules for a later layer (`services/privacy`, `services/decisions`) or on
 * LMS endpoints that do not exist yet. Rather than inventing data for those
 * surfaces, each one declares the capability it needs. The UI then renders an
 * honest, specific "not provisioned" panel naming the exact service, endpoint
 * and architecture section responsible.
 *
 * This is what makes the missing-backend story auditable: `CAPABILITIES` is the
 * single list of everything the frontend is waiting on, and
 * `capabilityReport()` prints it.
 */

export type CapabilityId =
  | 'lms.timetable'
  | 'lms.attendance'
  | 'lms.guardian-messages'
  | 'lms.event-reactions'
  | 'privacy.class-aggregates'
  | 'decisions.intervention-queue'
  | 'decisions.recommendations'
  | 'ai.document-analysis'
  | 'ai.lesson-generation'
  | 'ai.worksheet-generation'
  | 'ai.event-summary'
  | 'analytics.classroom-scoped'

export interface CapabilitySpec {
  readonly id: CapabilityId
  /** Human label used in the "not provisioned" panel. */
  readonly label: string
  /** Owning service directory, e.g. `services/lms`. */
  readonly service: string
  /** The endpoint this capability needs, in the shape the client would call. */
  readonly endpoint: string
  /** Governing section of ARCHITECTUREDesign.md. */
  readonly architectureRef: string
  /** What the teacher loses while it is missing. */
  readonly blocks: string
  /**
   * `blocked` means the architecture forbids shipping it now (a Layer 5
   * dependency); `missing` means it is merely unbuilt and may be added freely.
   */
  readonly reason: 'blocked' | 'missing'
}

export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilitySpec>> = {
  'lms.timetable': {
    id: 'lms.timetable',
    label: 'Class timetable / bell schedule',
    service: 'services/lms',
    endpoint: 'GET /api/lms/timetable?date=YYYY-MM-DD',
    architectureRef: '§9 — LMS owns classroom scheduling',
    blocks: 'Period times, lesson countdown and join-classroom links on the schedule card.',
    reason: 'missing',
  },
  'lms.attendance': {
    id: 'lms.attendance',
    label: 'Attendance register',
    service: 'services/lms',
    endpoint: 'POST /api/lms/classrooms/{id}/attendance',
    architectureRef: '§9 — LMS owns roster state',
    blocks: 'Attendance capture and the attendance-trend recommendation.',
    reason: 'missing',
  },
  'lms.guardian-messages': {
    id: 'lms.guardian-messages',
    label: 'Guardian messaging',
    service: 'services/lms',
    endpoint: 'GET /api/lms/guardian/threads',
    architectureRef: '§12 — guardian communication is a Privacy Guard surface',
    blocks: 'Parent messages in Pending Reviews and the guardian reply action.',
    reason: 'missing',
  },
  'lms.event-reactions': {
    id: 'lms.event-reactions',
    label: 'Reactions on stream events',
    service: 'services/lms',
    endpoint: 'POST /api/lms/announcements/{id}/reactions',
    architectureRef: '§9 — LMS owns the stream',
    blocks: 'Reactions on announcement and coursework events (comment reactions already work).',
    reason: 'missing',
  },
  'privacy.class-aggregates': {
    id: 'privacy.class-aggregates',
    label: 'Privacy Guard class aggregates',
    service: 'services/privacy',
    endpoint: 'GET /api/privacy/classrooms/{id}/aggregates',
    architectureRef: '§11 Layer 5 / §13 — no teacher PSV-derived view before the Privacy Guard',
    blocks: 'Mastery-derived risk signals, concept-confusion insights and predicted performance.',
    reason: 'blocked',
  },
  'decisions.intervention-queue': {
    id: 'decisions.intervention-queue',
    label: 'Deterministic intervention queue',
    service: 'services/decisions',
    endpoint: 'GET /api/decisions/classrooms/{id}/interventions',
    architectureRef: '§7 / §11 Layer 3 — intervention rules live in the decision service',
    blocks: 'Server-side intervention ranking. The client ruleset covers the LMS-evidence subset.',
    reason: 'blocked',
  },
  'decisions.recommendations': {
    id: 'decisions.recommendations',
    label: 'Teacher recommendations',
    service: 'services/decisions',
    endpoint: 'GET /api/decisions/teachers/{id}/recommendations',
    architectureRef: '§7 — teacher insight is an aggregate, privacy-filtered decision output',
    blocks: 'Recommendations that need mastery or misconception data.',
    reason: 'blocked',
  },
  'ai.document-analysis': {
    id: 'ai.document-analysis',
    label: 'Material analysis',
    service: 'services/ai',
    endpoint: 'POST /api/ai/materials/analyse',
    architectureRef: '§8 — RAG is a subroutine of the prompt compiler',
    blocks: 'The analyse step of the Upload Material workflow.',
    reason: 'missing',
  },
  'ai.lesson-generation': {
    id: 'ai.lesson-generation',
    label: 'Lesson generation',
    service: 'services/ai',
    endpoint: 'POST /api/ai/lessons/generate',
    architectureRef: '§8 / §11 Layer 4 — generation is a delivery-layer render',
    blocks: 'AI Lesson Generator quick action and the lesson step of the material workflow.',
    reason: 'missing',
  },
  'ai.worksheet-generation': {
    id: 'ai.worksheet-generation',
    label: 'Worksheet generation',
    service: 'services/ai',
    endpoint: 'POST /api/ai/worksheets/generate',
    architectureRef: '§8 / §11 Layer 4',
    blocks: 'The worksheet step of the Upload Material workflow.',
    reason: 'missing',
  },
  'ai.event-summary': {
    id: 'ai.event-summary',
    label: 'Timeline event summary',
    service: 'services/ai',
    endpoint: 'POST /api/ai/summaries',
    architectureRef: '§8 — outputs must pass safety validation before display',
    blocks: 'The AI summary line on timeline event cards.',
    reason: 'missing',
  },
  'analytics.classroom-scoped': {
    id: 'analytics.classroom-scoped',
    label: 'Classroom-scoped analytics/interventions',
    service: 'services/analytics',
    endpoint: 'GET /api/analytics/teacher/interventions?classroomId=',
    architectureRef:
      'Roster split — services/analytics keys on analytics_db.class_assignments, a roster ' +
      'entirely independent of lms_db.enrollments. Sprint 3 (P4, T4.3) named this rather than ' +
      'settling it: LMS must not write class_assignments as a side effect of a UI task — see ' +
      'HANDOFF.md\'s open Layer-2 blocker ("does roster live in auth_db or lms_db").',
    blocks:
      'Filtering analytics-derived signals (interventions, weak areas) down to one LMS ' +
      'classroom. Today they are teacher-scoped only — every class a teacher owns is mixed ' +
      'together, and the client-side interventions ruleset (riskRules.ts) is what actually ' +
      'provides a classroom-scoped queue in the meantime, from LMS-owned facts only.',
    reason: 'blocked',
  },
}

/** Discriminated result for anything that may not be provisioned yet. */
export type CapabilityState<T> =
  | { readonly kind: 'ready'; readonly data: T }
  | { readonly kind: 'unprovisioned'; readonly capability: CapabilitySpec }
  | { readonly kind: 'error'; readonly error: Error }

export const ready = <T,>(data: T): CapabilityState<T> => ({ kind: 'ready', data })

export const unprovisioned = <T,>(id: CapabilityId): CapabilityState<T> => ({
  kind: 'unprovisioned',
  capability: CAPABILITIES[id],
})

export const capabilityError = <T,>(error: Error): CapabilityState<T> => ({ kind: 'error', error })

/** HTTP statuses that mean "this endpoint is not implemented", not "it failed". */
const UNIMPLEMENTED_STATUSES: ReadonlySet<number> = new Set([404, 501, 502, 503])

export function isUnimplemented(status: number | undefined): boolean {
  return status !== undefined && UNIMPLEMENTED_STATUSES.has(status)
}

/** Every capability the frontend is waiting on, grouped by owning service. */
export function capabilityReport(): ReadonlyArray<{
  service: string
  items: readonly CapabilitySpec[]
}> {
  const byService = new Map<string, CapabilitySpec[]>()
  for (const spec of Object.values(CAPABILITIES)) {
    const bucket = byService.get(spec.service)
    if (bucket) bucket.push(spec)
    else byService.set(spec.service, [spec])
  }
  return [...byService.entries()]
    .map(([service, items]) => ({ service, items }))
    .sort((a, b) => a.service.localeCompare(b.service))
}
