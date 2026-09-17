const test = require('node:test');
const assert = require('node:assert/strict');

const { isCorrectAnswer, gradeQuizAttempt } = require('../lib/scoring');

const shortAnswer = (correctAnswer) => ({ id: 'q', type: 'short_answer', correctAnswer, marks: 1 });
const mcq = (correctAnswer) => ({ id: 'q', type: 'mcq', correctAnswer, marks: 1 });

/* ── The defect these cover ──────────────────────────────────────────────────
   `isReasonableShortAnswerMatch` granted credit on bare substring containment,
   guarded by `min(studentLen, correctLen) >= min(12, correctLen)`. When the
   correct answer is shorter than 12 characters that right-hand side collapses
   to `correctLen`, and containment already implies the left-hand side equals
   `correctLen` — so the guard was vacuously true and *any* string containing
   the answer scored full marks. Key "acid" accepted "not acid"; key "7"
   accepted "17"; key "ice" accepted "nice".

   Marking a wrong answer correct is the worse direction here: the score feeds
   the learner's record, and an incorrect answer is what mints a
   `weakAreaLabel`, so a bad grade propagates into teacher-facing insight. ── */

test('short answer: rejects a negated restatement of a short key', () => {
  assert.equal(isCorrectAnswer(shortAnswer('acid'), 'not acid'), false);
  assert.equal(isCorrectAnswer(shortAnswer('acid'), 'acid'), true);
});

test('short answer: rejects a numeric key embedded in a different number', () => {
  assert.equal(isCorrectAnswer(shortAnswer('7'), '17'), false);
  assert.equal(isCorrectAnswer(shortAnswer('7'), '27'), false);
  assert.equal(isCorrectAnswer(shortAnswer('7'), '0.7'), false);
  assert.equal(isCorrectAnswer(shortAnswer('7'), '7'), true);
});

test('short answer: rejects a short key that is merely a substring of another word', () => {
  assert.equal(isCorrectAnswer(shortAnswer('ice'), 'nice'), false);
  assert.equal(isCorrectAnswer(shortAnswer('mass'), 'biomass'), false);
  assert.equal(isCorrectAnswer(shortAnswer('ice'), 'ice'), true);
});

/* ── Leniency that must survive the fix ──────────────────────────────────── */

test('short answer: still accepts a longer key stated inside a fuller sentence', () => {
  // 14 chars, so the containment path is legitimately available.
  assert.equal(
    isCorrectAnswer(shortAnswer('Photosynthesis'), 'Photosynthesis happens in leaves'),
    true,
  );
});

test('short answer: still accepts a high token overlap on a multi-word key', () => {
  assert.equal(
    isCorrectAnswer(
      shortAnswer('carbon dioxide and water'),
      'water and carbon dioxide are used',
    ),
    true,
  );
});

test('short answer: is case- and punctuation-insensitive', () => {
  assert.equal(isCorrectAnswer(shortAnswer('Photosynthesis'), '  photosynthesis!  '), true);
});

/* ── Negation must not pass on the token-overlap path either ─────────────── */

test('short answer: rejects a negated restatement of a multi-word key', () => {
  // Every meaningful token overlaps, so token ratio alone would accept this.
  assert.equal(
    isCorrectAnswer(
      shortAnswer('carbon dioxide and water'),
      'not carbon dioxide and water',
    ),
    false,
  );
});

/* ── MCQ is exact-match only; fuzzy matching must never apply ────────────── */

test('mcq: requires exact match and never falls through to fuzzy matching', () => {
  assert.equal(isCorrectAnswer(mcq('Plane mirror'), 'Plane mirror'), true);
  assert.equal(isCorrectAnswer(mcq('Plane mirror'), 'Not a plane mirror'), false);
  assert.equal(isCorrectAnswer(mcq('7'), '17'), false);
});

/* ── Empty and malformed input ───────────────────────────────────────────── */

test('rejects empty, missing and non-scalar answers', () => {
  assert.equal(isCorrectAnswer(shortAnswer('acid'), ''), false);
  assert.equal(isCorrectAnswer(shortAnswer('acid'), null), false);
  assert.equal(isCorrectAnswer(shortAnswer('acid'), undefined), false);
  assert.equal(isCorrectAnswer(shortAnswer('acid'), { a: 1 }), false);
  assert.equal(isCorrectAnswer(shortAnswer(''), 'anything'), false);
});

/* ── The grade sheet, end to end ─────────────────────────────────────────── */

test('a wrong short answer scores zero and produces a weak-area signal', () => {
  const quiz = {
    questions: [
      {
        id: 'q1',
        orderIndex: 1,
        type: 'short_answer',
        difficulty: 'simple',
        conceptTag: 'Acids and bases',
        weakAreaLabel: 'Identifying acids',
        prompt: 'What kind of substance turns blue litmus red?',
        correctAnswer: 'acid',
        marks: 2,
      },
    ],
  };

  const graded = gradeQuizAttempt(quiz, { q1: 'not acid' });

  assert.equal(graded.score, 0);
  assert.equal(graded.maxScore, 2);
  assert.equal(graded.percentage, 0);
  assert.equal(graded.correctCount, 0);
  assert.deepEqual(
    graded.weakAreas.map(area => area.label),
    ['Identifying acids'],
  );
});

test('a correct short answer scores full marks and produces no weak area', () => {
  const quiz = {
    questions: [
      {
        id: 'q1',
        orderIndex: 1,
        type: 'short_answer',
        conceptTag: 'Acids and bases',
        weakAreaLabel: 'Identifying acids',
        correctAnswer: 'acid',
        marks: 2,
      },
    ],
  };

  const graded = gradeQuizAttempt(quiz, { q1: 'Acid' });

  assert.equal(graded.score, 2);
  assert.equal(graded.percentage, 100);
  assert.deepEqual(graded.weakAreas, []);
});
