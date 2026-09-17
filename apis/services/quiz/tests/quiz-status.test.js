const test = require('node:test');
const assert = require('node:assert/strict');

const { QUIZ_STATUS, isStudentVisible, isActive } = require('../lib/quiz-status');
const { needsGeneration } = require('../lib/chapters');

/* ── The defect these cover ──────────────────────────────────────────────────
   Quizzes are drafted by a language model and were created `ready`, which is
   exactly what the student endpoints filter on — so generation *was*
   publication and no human ever saw the questions. `validateQuizDraft` checks
   shape only; nothing in the pipeline can tell whether an answer key is right.

   A wrong key does not just cost a mark: `gradeQuizAttempt` mints a
   `weakAreaLabel` from every incorrect answer, so it marks a correct child
   wrong and then reports that concept as a class weakness to the teacher. ── */

test('a freshly drafted quiz is not visible to students', () => {
  assert.equal(isStudentVisible(QUIZ_STATUS.PENDING_REVIEW), false);
});

test('only an approved quiz is visible to students', () => {
  assert.equal(isStudentVisible(QUIZ_STATUS.READY), true);
  assert.equal(isStudentVisible(QUIZ_STATUS.ARCHIVED), false);
  assert.equal(isStudentVisible('generating'), false);
  assert.equal(isStudentVisible(undefined), false);
});

test('a quiz awaiting review still occupies the chapter slot', () => {
  // If pending_review were not "active", every sync would regenerate over the
  // teacher's pending decision and re-spend the model call.
  assert.equal(isActive(QUIZ_STATUS.PENDING_REVIEW), true);
  assert.equal(isActive(QUIZ_STATUS.READY), true);
  assert.equal(isActive(QUIZ_STATUS.ARCHIVED), false);
});

/* ── needsGeneration must respect a pending decision ─────────────────────── */

const source = { id: 's1', contentFingerprint: 'fp-1' };

test('does not regenerate over a quiz that is awaiting approval', () => {
  const pending = { status: QUIZ_STATUS.PENDING_REVIEW, contentFingerprint: 'fp-1' };
  assert.equal(needsGeneration(source, pending), false);
});

test('does not regenerate over an approved, up-to-date quiz', () => {
  const ready = { status: QUIZ_STATUS.READY, contentFingerprint: 'fp-1' };
  assert.equal(needsGeneration(source, ready), false);
});

test('regenerates when the chapter content has changed', () => {
  const stale = { status: QUIZ_STATUS.PENDING_REVIEW, contentFingerprint: 'fp-OLD' };
  assert.equal(needsGeneration(source, stale), true);
});

test('regenerates when the only quiz has been archived', () => {
  const archived = { status: QUIZ_STATUS.ARCHIVED, contentFingerprint: 'fp-1' };
  assert.equal(needsGeneration(source, archived), true);
});

test('regenerates when there is no quiz at all', () => {
  assert.equal(needsGeneration(source, null), true);
});

test('does nothing without a source', () => {
  assert.equal(needsGeneration(null, null), false);
});
