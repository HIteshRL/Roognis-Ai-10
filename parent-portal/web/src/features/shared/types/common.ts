/**
 * Cross-feature primitives.
 *
 * Everything the Command Center, Timeline and AI Inbox exchange is described
 * here. Two rules from `ARCHITECTUREDesign.md` are encoded as types rather than
 * conventions, because conventions are not enforceable:
 *
 *  - §7 "Explainability contract" — a decision that cannot produce its evidence
 *    is not a decision. `Evidence` is therefore non-optional on every derived
 *    artefact (`StudentRisk`, `AIInsight`, `Recommendation`).
 *  - §6.2 / §13 — no derived artefact exists without `Provenance` carrying the
 *    evidence ids, the ruleset version and the gate version that produced it.
 */

/** Roster identity. Deliberately minimal: LMS-owned fields only, never PSV. */
export interface StudentRef {
  readonly studentId: string
  readonly name: string
  /** Present only where the caller already has classroom scope. */
  readonly classroomId?: string
  readonly classroomName?: string
}

/** Where a derived value came from. `psv-aggregate` requires the Privacy Guard. */
export type DerivationSource =
  | 'lms-coursework'
  | 'lms-engagement'
  | 'psv-aggregate'
  | 'decision-service'

/**
 * §6.2: a derived value must name the evidence, the ruleset and the gate that
 * produced it. Client-side rulesets set `computedBy: 'client-ruleset'` so a
 * later server implementation is distinguishable in logs and in the UI.
 */
export interface Provenance {
  readonly source: DerivationSource
  readonly rulesetVersion: string
  readonly gateVersion: string
  readonly computedAt: string
  readonly computedBy: 'client-ruleset' | 'decision-service' | 'privacy-guard'
  readonly evidenceIds: readonly string[]
}

/** A single citable fact. `ref` points at a real LMS record the teacher can open. */
export interface Evidence {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly observedAt: string
  readonly ref?: EvidenceRef
}

export interface EvidenceRef {
  readonly kind: 'coursework' | 'submission' | 'announcement' | 'classroom' | 'student'
  readonly id: string
  readonly classroomId?: string
}

/**
 * Confidence is a bounded 0..1 scalar plus the sample it rests on. A confidence
 * without a sample size is not interpretable, so both travel together.
 */
export interface Confidence {
  readonly score: number
  readonly sampleSize: number
  readonly basis: string
}

export type Priority = 'critical' | 'high' | 'medium' | 'low'

export const PRIORITY_ORDER: Readonly<Record<Priority, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Comparator for descending urgency; stable for equal priorities. */
export function byPriority<T extends { priority: Priority }>(a: T, b: T): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
}

/** An action the UI can offer. `run` is resolved by the workflow engine. */
export interface SuggestedAction {
  readonly id: string
  readonly label: string
  readonly kind: ActionKind
  readonly intent: 'primary' | 'secondary'
  /** Params handed to the workflow engine when the action is executed. */
  readonly params: Readonly<Record<string, string>>
}

export type ActionKind =
  | 'open-classroom'
  | 'open-coursework'
  | 'open-student'
  | 'grade-submissions'
  | 'create-assignment'
  | 'create-quiz'
  | 'upload-material'
  | 'generate-lesson'
  | 'take-attendance'
  | 'post-announcement'
  | 'schedule-revision'
  | 'message-guardian'

/* ── Async / server state ─────────────────────────────────────────────────── */

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error'

export interface AsyncState<T> {
  readonly status: AsyncStatus
  readonly data: T | null
  readonly error: Error | null
  /** True while a background refresh runs over data that is already displayed. */
  readonly refreshing: boolean
}

export const idleState = <T,>(): AsyncState<T> => ({
  status: 'idle',
  data: null,
  error: null,
  refreshing: false,
})

/* ── Pagination ───────────────────────────────────────────────────────────── */

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
  readonly total: number
}

export const emptyPage = <T,>(): Page<T> => ({ items: [], nextCursor: null, total: 0 })
