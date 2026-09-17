const test = require('node:test');
const assert = require('node:assert/strict');

const { QUIZ_STATUS, approvalDecision, isStudentVisible } = require('../lib/quiz-status');

/* ── What these cover ────────────────────────────────────────────────────────
   `POST /api/quiz/quizzes/:quizId/approve` is the only human correctness gate
   in the pipeline. Everything upstream of it is a language model plus a shape
   check, and `validateQuizDraft` cannot tell whether an answer key is right.

   The route's own scoping (`teacherOnly`, and a `findFirst` keyed on
   `schoolId: req.user.schoolId` so another school's quiz is a 404) is enforced
   by middleware and the query, and is covered where those live. What is
   asserted here is the transition decision itself — the part that says whether
   a given quiz may become student-visible at all.                          ── */

test('a quiz awaiting review may be approved', () => {
  assert.deepEqual(approvalDecision(QUIZ_STATUS.PENDING_REVIEW), { ok: true });
});

test('approving an already-approved quiz is refused, not silently accepted', () => {
  // A silent success would let a double-submit in the UI be indistinguishable
  // from a second reviewer having independently checked the answer keys.
  const decision = approvalDecision(QUIZ_STATUS.READY);
  assert.equal(decision.ok, false);
  assert.equal(decision.httpStatus, 409);
  assert.equal(decision.error, 'Quiz is already approved.');
});

test('an archived quiz cannot be resurrected by approving it', () => {
  const decision = approvalDecision(QUIZ_STATUS.ARCHIVED);
  assert.equal(decision.ok, false);
  assert.equal(decision.httpStatus, 409);
  assert.match(decision.error, /archived/);
});

test('an unknown status is refused rather than treated as approvable', () => {
  // Fail closed: a status this build does not know about must never fall
  // through into publication.
  for (const status of ['generating', 'draft', '', null, undefined]) {
    const decision = approvalDecision(status);
    assert.equal(decision.ok, false, `status ${JSON.stringify(status)} must not be approvable`);
    assert.equal(decision.httpStatus, 409);
  }
});

test('only the status approval produces is student-visible', () => {
  // Ties the gate to its consequence: the one transition approvalDecision
  // permits is the one — and only one — the student endpoints will serve.
  assert.equal(isStudentVisible(QUIZ_STATUS.PENDING_REVIEW), false);
  assert.equal(approvalDecision(QUIZ_STATUS.PENDING_REVIEW).ok, true);
  assert.equal(isStudentVisible(QUIZ_STATUS.READY), true);
});

test('every refusal carries an error message for the teacher', () => {
  for (const status of [QUIZ_STATUS.READY, QUIZ_STATUS.ARCHIVED, 'generating']) {
    const decision = approvalDecision(status);
    assert.equal(typeof decision.error, 'string');
    assert.ok(decision.error.length > 0, `status ${status} must explain the refusal`);
  }
});
