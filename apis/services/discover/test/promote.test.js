'use strict';
// The gate between a model's suggestion and the system's belief.
//
// If any of these fail, an LLM has gained a path to write learner-facing state
// without a human or a counter in front of it. That is the MASTERCONTEXT §7
// line, so treat a failure here as a design regression, not a flaky test.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  candidateDecision, mergeEvidence, PROMOTION_EVIDENCE_THRESHOLD, SEED_WEIGHTS,
} = require('../interest/promote');

const pending = (over = {}) => ({ key: 'rock-climbing', label: 'Rock climbing', status: 'pending', evidenceCount: 1, ...over });

test('a student accepting is the primary promotion path', () => {
  const outcome = candidateDecision({ candidate: pending(), decision: 'accept' });
  assert.equal(outcome.action, 'promote');
  assert.equal(outcome.origin, 'confirmed');
  assert.equal(outcome.weight, SEED_WEIGHTS.confirmed);
  assert.equal(outcome.reason, 'student_confirmed');
});

test('a student rejecting tombstones the candidate', () => {
  const outcome = candidateDecision({ candidate: pending(), decision: 'reject' });
  assert.equal(outcome.action, 'reject');
  assert.equal(outcome.weight, 0);
});

test('a rejected candidate can never be revived', () => {
  // The "no" has to stick, or the card returns every week and the control is a
  // lie. Both an explicit re-accept and the unattended path must refuse.
  for (const decision of ['accept', 'reject', null]) {
    const outcome = candidateDecision({ candidate: pending({ status: 'rejected', evidenceCount: 99 }), decision });
    assert.equal(outcome.action, 'noop', `decision=${decision} must not revive a rejected candidate`);
    assert.equal(outcome.reason, 'already_rejected');
  }
});

test('an accepted candidate is final', () => {
  const outcome = candidateDecision({ candidate: pending({ status: 'accepted' }), decision: 'reject' });
  assert.equal(outcome.action, 'noop');
  assert.equal(outcome.reason, 'already_accepted');
});

test('repeated independent evidence promotes without a student answer', () => {
  const below = candidateDecision({ candidate: pending({ evidenceCount: PROMOTION_EVIDENCE_THRESHOLD - 1 }) });
  assert.equal(below.action, 'noop');
  assert.equal(below.reason, 'awaiting_evidence');

  const at = candidateDecision({ candidate: pending({ evidenceCount: PROMOTION_EVIDENCE_THRESHOLD }) });
  assert.equal(at.action, 'promote');
  assert.equal(at.origin, 'behaviour');
  assert.equal(at.reason, 'repeated_evidence');
});

test('an unattended promotion is weighted below a confirmed one', () => {
  assert.ok(SEED_WEIGHTS.behaviour < SEED_WEIGHTS.confirmed,
    'an inferred interest must never outrank one the student chose');
  assert.ok(SEED_WEIGHTS.onboarding > 0 && SEED_WEIGHTS.confirmed < 50,
    'seed weights stay inside the node clamp so ordinary reading can still overtake them');
});

test('a malformed decision is refused rather than guessed at', () => {
  for (const decision of ['ACCEPT', 'yes', 'maybe', 'promote', '']) {
    const outcome = candidateDecision({ candidate: pending(), decision });
    assert.equal(outcome.action, 'noop', `"${decision}" must not promote`);
    assert.equal(outcome.reason, 'invalid_decision');
  }
});

test('a missing or keyless candidate decides nothing', () => {
  assert.equal(candidateDecision({}).action, 'noop');
  assert.equal(candidateDecision({ candidate: null, decision: 'accept' }).action, 'noop');
  assert.equal(candidateDecision({ candidate: { status: 'pending' }, decision: 'accept' }).action, 'noop');
});

test('evidence counts once per session, not once per mention', () => {
  // Without this, one long reading session that mentions climbing five times
  // clears the threshold on its own. That is one observation, not three.
  const first = mergeEvidence({ existing: null, sessionId: 's1', evidenceUrls: ['https://a'] });
  assert.equal(first.evidenceCount, 1);

  const existing = { evidenceCount: 1, evidence: first.evidence };
  const same = mergeEvidence({ existing, sessionId: 's1', evidenceUrls: ['https://b'] });
  assert.equal(same.evidenceCount, 1, 'the same session must not count twice');
  assert.equal(same.counted, false);

  const next = mergeEvidence({ existing, sessionId: 's2', evidenceUrls: ['https://c'] });
  assert.equal(next.evidenceCount, 2);
  assert.equal(next.counted, true);
});

test('a sessionless call counts once total, not once per call', () => {
  // Regression: evidenceCount used to increment unconditionally whenever
  // sessionId was falsy, since `isNewSession || !sessionId` always took the
  // `!sessionId` branch. A client that omits sessionId (or double-fires an
  // endpoint like /session/end) would inflate the count on every call.
  const first = mergeEvidence({ existing: null, sessionId: null, evidenceUrls: ['https://a'] });
  assert.equal(first.evidenceCount, 1);

  const existing = { evidenceCount: 1, evidence: first.evidence };
  const second = mergeEvidence({ existing, sessionId: null, evidenceUrls: ['https://b'] });
  assert.equal(second.evidenceCount, 1, 'a second sessionless call must not count again');
  assert.equal(second.counted, false);

  const third = mergeEvidence({ existing, sessionId: undefined, evidenceUrls: ['https://c'] });
  assert.equal(third.evidenceCount, 1, 'undefined sessionId is the same case as null');
  assert.equal(third.counted, false);

  // A real session afterward still counts independently of the sessionless one.
  const withSession = mergeEvidence({ existing, sessionId: 's1', evidenceUrls: ['https://d'] });
  assert.equal(withSession.evidenceCount, 2);
  assert.equal(withSession.counted, true);
});

test('three distinct sessions are what it takes to auto-promote', () => {
  let row = { evidenceCount: 0, evidence: [], status: 'pending', key: 'drones' };
  for (const sessionId of ['s1', 's2', 's3']) {
    const merged = mergeEvidence({ existing: row, sessionId });
    row = { ...row, evidenceCount: merged.evidenceCount, evidence: merged.evidence };
  }
  assert.equal(row.evidenceCount, PROMOTION_EVIDENCE_THRESHOLD);
  assert.equal(candidateDecision({ candidate: row }).action, 'promote');
});

test('the evidence log is bounded so a Json column cannot grow without limit', () => {
  let row = { evidenceCount: 0, evidence: [] };
  for (let i = 0; i < 40; i += 1) {
    const merged = mergeEvidence({ existing: row, sessionId: `s${i}`, evidenceUrls: ['https://a'] });
    row = { evidenceCount: merged.evidenceCount, evidence: merged.evidence };
  }
  assert.ok(row.evidence.length <= 12, `evidence log capped, got ${row.evidence.length}`);
  assert.equal(row.evidenceCount, 40, 'the count is not lost when the log is trimmed');
});
