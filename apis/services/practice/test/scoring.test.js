const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isCorrectAnswer, gradePracticeAttempt } = require('../scoring');

const quiz = [
  {
    id: 'q1',
    prompt: 'What gas do plants release during photosynthesis?',
    options: ['Oxygen', 'Nitrogen', 'Hydrogen', 'Carbon monoxide'],
    correctAnswer: 'Oxygen',
    explanation: 'Photosynthesis releases oxygen as a byproduct.',
    conceptTag: 'Photosynthesis products',
  },
  {
    id: 'q2',
    prompt: 'Where does photosynthesis take place?',
    options: ['Chloroplasts', 'Mitochondria', 'Nucleus', 'Ribosomes'],
    correctAnswer: 'Chloroplasts',
    explanation: 'Chloroplasts contain chlorophyll needed for photosynthesis.',
    conceptTag: 'Cell organelles',
  },
];

describe('isCorrectAnswer', () => {
  it('matches only an exact string', () => {
    assert.equal(isCorrectAnswer(quiz[0], 'Oxygen'), true);
  });

  it('never falls through to a fuzzy match — case and whitespace must match exactly', () => {
    // Deliberately no leniency here — see scoring.js's header comment on why
    // services/quiz's fuzzy short-answer matcher was not duplicated.
    assert.equal(isCorrectAnswer(quiz[0], 'oxygen'), false);
    assert.equal(isCorrectAnswer(quiz[0], ' Oxygen'), false);
    assert.equal(isCorrectAnswer(quiz[0], 'Oxygen '), false);
  });

  it('treats a non-string or missing answer as incorrect, not a crash', () => {
    assert.equal(isCorrectAnswer(quiz[0], null), false);
    assert.equal(isCorrectAnswer(quiz[0], undefined), false);
    assert.equal(isCorrectAnswer(quiz[0], 42), false);
  });
});

describe('gradePracticeAttempt', () => {
  it('scores a perfect attempt with no weak areas', () => {
    const graded = gradePracticeAttempt(quiz, { q1: 'Oxygen', q2: 'Chloroplasts' });
    assert.equal(graded.score, 2);
    assert.equal(graded.maxScore, 2);
    assert.equal(graded.percentage, 100);
    assert.equal(graded.correctCount, 2);
    assert.equal(graded.questionCount, 2);
    assert.deepEqual(graded.weakAreas, []);
  });

  it('produces exactly one weakAreas entry per wrong answer, keyed by conceptTag', () => {
    const graded = gradePracticeAttempt(quiz, { q1: 'Nitrogen', q2: 'Chloroplasts' });
    assert.equal(graded.score, 1);
    assert.equal(graded.percentage, 50);
    assert.equal(graded.weakAreas.length, 1);
    assert.equal(graded.weakAreas[0].label, 'Photosynthesis products');
    assert.equal(graded.weakAreas[0].conceptTag, 'Photosynthesis products');
    assert.equal(graded.weakAreas[0].questionId, 'q1');
  });

  it('treats a missing answer as incorrect rather than throwing', () => {
    const graded = gradePracticeAttempt(quiz, { q1: 'Oxygen' }); // q2 never answered
    assert.equal(graded.score, 1);
    assert.equal(graded.results.find(r => r.questionId === 'q2').correct, false);
    assert.equal(graded.results.find(r => r.questionId === 'q2').studentAnswer, null);
    assert.equal(graded.weakAreas.length, 1);
    assert.equal(graded.weakAreas[0].questionId, 'q2');
  });

  it('ignores answers keyed to unknown question ids rather than erroring', () => {
    const graded = gradePracticeAttempt(quiz, { q1: 'Oxygen', q2: 'Chloroplasts', q99: 'Whatever' });
    assert.equal(graded.score, 2);
    assert.equal(Object.keys(graded.answers).length, 2);
  });

  it('echoes every submitted answer back in .answers, including nulls for unanswered', () => {
    const graded = gradePracticeAttempt(quiz, { q1: 'Oxygen' });
    assert.deepEqual(graded.answers, { q1: 'Oxygen', q2: null });
  });

  it('handles an empty quiz without dividing by zero', () => {
    const graded = gradePracticeAttempt([], {});
    assert.equal(graded.questionCount, 0);
    assert.equal(graded.percentage, 0);
    assert.deepEqual(graded.weakAreas, []);
  });
});
