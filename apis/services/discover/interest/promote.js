'use strict';
// The gate between "a model noticed something" and "the system believes it".
//
// interest/propose.js may write InterestCandidate rows all day; nothing there
// reaches ranking, the hunt or the tutor prompt. This module is the only way a
// candidate becomes an InterestNode, and every rule in it is a plain
// comparison — a human decision, or an integer count of independent evidence.
// Modelled on services/quiz/lib/quiz-status.js's approvalDecision: the decision
// is a pure function, so it can be tested without a database.
//
// If you are tempted to add "…or if the model is confident enough", don't. That
// is the exact move MASTERCONTEXT §7 exists to prevent.

/** Distinct reading sessions that must independently evidence a candidate. */
const PROMOTION_EVIDENCE_THRESHOLD = 3;

// Seed weights. A confirmed interest outranks an inferred one because the
// student said so; both stay well under the 50 clamp so ordinary reading can
// still overtake them.
const SEED_WEIGHTS = Object.freeze({
  confirmed: 3.2,
  behaviour: 1.4,
  onboarding: 1.0,
  imported: 0,      // imported nodes carry their own weight across
});

const DECISIONS = Object.freeze(['accept', 'reject']);

/**
 * What should happen to this candidate?
 *
 * @param {object}  candidate          the stored row
 * @param {string?} decision           'accept' | 'reject' from the student, or null for the
 *                                     unattended evidence-threshold check
 * @param {number}  evidenceThreshold
 * @returns {{action:'promote'|'reject'|'noop', origin:string|null, weight:number, reason:string}}
 */
function candidateDecision({ candidate, decision = null, evidenceThreshold = PROMOTION_EVIDENCE_THRESHOLD } = {}) {
  const noop = reason => ({ action: 'noop', origin: null, weight: 0, reason });

  if (!candidate || !candidate.key) return noop('no_candidate');

  // A decided candidate is final. Re-accepting is harmless but re-rejecting a
  // promoted one must not silently delete a node the student is using, and a
  // rejected one must never come back — that is what makes the "no" stick.
  if (candidate.status === 'rejected') return noop('already_rejected');
  if (candidate.status === 'accepted') return noop('already_accepted');
  if (candidate.status !== 'pending') return noop('not_pending');

  if (decision !== null && !DECISIONS.includes(decision)) return noop('invalid_decision');

  if (decision === 'reject') {
    return { action: 'reject', origin: null, weight: 0, reason: 'student_rejected' };
  }
  if (decision === 'accept') {
    return { action: 'promote', origin: 'confirmed', weight: SEED_WEIGHTS.confirmed, reason: 'student_confirmed' };
  }

  // Unattended path: the student never answered, but the same interest showed
  // up in enough separate sessions that a counter, not a model, can call it.
  if (Number(candidate.evidenceCount || 0) >= evidenceThreshold) {
    return { action: 'promote', origin: 'behaviour', weight: SEED_WEIGHTS.behaviour, reason: 'repeated_evidence' };
  }

  return noop('awaiting_evidence');
}

/**
 * Merge a fresh proposal into the candidate set.
 *
 * Evidence only counts once per session: without that, a single long reading
 * session that mentions climbing five times would clear the threshold on its
 * own, which is one observation, not three.
 */
function mergeEvidence({ existing, sessionId, evidenceUrls = [], maxEvidence = 12 } = {}) {
  const prior = Array.isArray(existing?.evidence) ? existing.evidence : [];
  const seenSessions = new Set(prior.map(e => e?.sessionId).filter(Boolean));

  // With a sessionId, dedupe against sessions already seen. Without one (a
  // manual or backfilled proposal), there is no session to key on, so it
  // dedupes against whether a sessionless observation has already landed —
  // otherwise a client that omits sessionId, or double-fires an endpoint
  // like /session/end, would inflate evidenceCount on every single call
  // instead of counting once, defeating the whole point of this gate.
  const isNewObservation = sessionId
    ? !seenSessions.has(sessionId)
    : !prior.some(e => !e?.sessionId);

  const entry = {
    sessionId: sessionId || null,
    urls: evidenceUrls.filter(u => typeof u === 'string').slice(0, 4),
  };
  const evidence = [...prior, entry].slice(-maxEvidence);

  return {
    evidence,
    evidenceCount: existing
      ? Number(existing.evidenceCount || 0) + (isNewObservation ? 1 : 0)
      : 1,
    counted: existing ? isNewObservation : true,
  };
}

module.exports = {
  PROMOTION_EVIDENCE_THRESHOLD, SEED_WEIGHTS, DECISIONS,
  candidateDecision, mergeEvidence,
};
