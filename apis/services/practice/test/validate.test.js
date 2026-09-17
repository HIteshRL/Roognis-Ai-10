const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePracticeSetSpec,
  collectPracticeSetText,
  PRACTICE_LIMITS,
  PracticeValidationError,
} = require('../validate');

const KNOWN = ['chunk-a', 'chunk-b', 'chunk-c'];

function baseSpec(overrides = {}) {
  return {
    summary: {
      title: 'Photosynthesis',
      body: 'Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.',
    },
    flashcards: [
      { front: 'What is photosynthesis?', back: 'The process of converting light energy into chemical energy.' },
      { front: 'Where does photosynthesis occur?', back: 'In the chloroplasts of plant cells.' },
      { front: 'What gas is released?', back: 'Oxygen.' },
      { front: 'What pigment absorbs light?', back: 'Chlorophyll.' },
    ],
    quiz: [
      {
        prompt: 'What gas do plants release during photosynthesis?',
        options: ['Oxygen', 'Nitrogen', 'Hydrogen', 'Carbon monoxide'],
        correctAnswer: 'Oxygen',
        explanation: 'Photosynthesis releases oxygen as a byproduct.',
        conceptTag: 'Photosynthesis products',
      },
      {
        prompt: 'Where does photosynthesis take place?',
        options: ['Chloroplasts', 'Mitochondria', 'Nucleus', 'Ribosomes'],
        correctAnswer: 'Chloroplasts',
        explanation: 'Chloroplasts contain chlorophyll needed for photosynthesis.',
        conceptTag: 'Cell organelles',
      },
      {
        prompt: 'What pigment captures light energy?',
        options: ['Chlorophyll', 'Melanin', 'Keratin', 'Hemoglobin'],
        correctAnswer: 'Chlorophyll',
        explanation: 'Chlorophyll absorbs light for photosynthesis.',
        conceptTag: 'Photosynthesis pigments',
      },
      {
        prompt: 'What is the main input gas for photosynthesis?',
        options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
        correctAnswer: 'Carbon dioxide',
        explanation: 'Plants take in carbon dioxide for photosynthesis.',
        conceptTag: 'Photosynthesis inputs',
      },
    ],
    citations: ['chunk-a'],
    ...overrides,
  };
}

/** Assert it throws, and that the message actually names the problem. */
function rejects(spec, ...expectedFragments) {
  let message = null;
  try {
    validatePracticeSetSpec(spec, { knownChunkIds: KNOWN });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message, 'expected the spec to be rejected');
  for (const fragment of expectedFragments) {
    assert.ok(
      message.toLowerCase().includes(fragment.toLowerCase()),
      `message should mention "${fragment}" — it becomes the model's correction turn. Got: ${message}`
    );
  }
  return message;
}

describe('practice-set spec validation', () => {
  it('accepts and normalizes a good spec, assigning ids server-side', () => {
    const spec = validatePracticeSetSpec(baseSpec(), { knownChunkIds: KNOWN });
    assert.equal(spec.summary.title, 'Photosynthesis');
    assert.equal(spec.flashcards.length, 4);
    assert.equal(spec.flashcards[0].id, 'f1');
    assert.equal(spec.flashcards[3].id, 'f4');
    assert.equal(spec.quiz.length, 4);
    assert.equal(spec.quiz[0].id, 'q1');
    assert.equal(spec.quiz[3].id, 'q4');
    assert.deepEqual(spec.citations, ['chunk-a']);
  });

  it('rejects a non-object payload', () => {
    rejects(null, 'json object');
    rejects([], 'json object');
  });

  it('rejects a missing summary object', () => {
    rejects(baseSpec({ summary: 'not an object' }), 'summary', 'object');
  });

  it('rejects a missing or overlong summary title', () => {
    rejects(baseSpec({ summary: { title: '', body: baseSpec().summary.body } }), 'summary.title', 'empty');
    rejects(
      baseSpec({ summary: { title: 'x'.repeat(PRACTICE_LIMITS.summaryTitleMaxChars + 1), body: baseSpec().summary.body } }),
      'summary.title', 'at most'
    );
  });

  it('rejects a too-short or too-long summary body', () => {
    rejects(baseSpec({ summary: { title: 'Title', body: 'Too short.' } }), 'summary.body', 'empty');
    rejects(
      baseSpec({ summary: { title: 'Title', body: 'x'.repeat(PRACTICE_LIMITS.summaryBodyMaxChars + 1) } }),
      'summary.body', 'at most'
    );
  });

  it('rejects too few and too many flashcards, naming the bound and the count', () => {
    const tooFew = rejects(baseSpec({ flashcards: baseSpec().flashcards.slice(0, 2) }), 'flashcards', '4 to 10', 'got 2');
    assert.ok(/got 2/.test(tooFew));

    const many = Array.from({ length: 11 }, (_, i) => ({ front: `Front ${i}`, back: `Back ${i}` }));
    rejects(baseSpec({ flashcards: many }), 'flashcards', '4 to 10', 'got 11');
  });

  it('rejects an overlong flashcard front or back', () => {
    const cards = baseSpec().flashcards;
    cards[0] = { front: 'x'.repeat(PRACTICE_LIMITS.flashcardFrontMaxChars + 1), back: 'Back' };
    rejects(baseSpec({ flashcards: cards }), 'flashcards[0].front', 'at most');
  });

  it('rejects too few and too many quiz questions', () => {
    rejects(baseSpec({ quiz: baseSpec().quiz.slice(0, 2) }), 'quiz', '4 to 10', 'got 2');
  });

  it('rejects a quiz question without exactly 4 options', () => {
    const quiz = baseSpec().quiz;
    quiz[0] = { ...quiz[0], options: ['Oxygen', 'Nitrogen', 'Hydrogen'] };
    rejects(baseSpec({ quiz }), 'quiz[0].options', 'got 3');
  });

  it('rejects duplicate options within one question', () => {
    const quiz = baseSpec().quiz;
    quiz[0] = { ...quiz[0], options: ['Oxygen', 'Oxygen', 'Hydrogen', 'Nitrogen'] };
    rejects(baseSpec({ quiz }), 'duplicate value');
  });

  it('rejects weak MCQ options like "all of the above"', () => {
    const quiz = baseSpec().quiz;
    quiz[0] = { ...quiz[0], options: ['Oxygen', 'Nitrogen', 'Hydrogen', 'All of the above'] };
    rejects(baseSpec({ quiz }), 'not a real distractor');

    const quiz2 = baseSpec().quiz;
    quiz2[0] = { ...quiz2[0], options: ['Oxygen', 'Nitrogen', 'Both A and B', 'Hydrogen'] };
    rejects(baseSpec({ quiz: quiz2 }), 'not a real distractor');
  });

  it('rejects a correctAnswer that does not exactly match one option', () => {
    const quiz = baseSpec().quiz;
    quiz[0] = { ...quiz[0], correctAnswer: 'oxygen' }; // wrong case, not exact
    rejects(baseSpec({ quiz }), 'correctAnswer', 'must exactly match');
  });

  it('rejects an overlong prompt, explanation, or conceptTag', () => {
    const quiz = baseSpec().quiz;
    quiz[0] = { ...quiz[0], prompt: 'x'.repeat(PRACTICE_LIMITS.quizPromptMaxChars + 1) };
    rejects(baseSpec({ quiz }), 'quiz[0].prompt', 'at most');

    const quiz2 = baseSpec().quiz;
    quiz2[0] = { ...quiz2[0], explanation: 'x'.repeat(PRACTICE_LIMITS.quizExplanationMaxChars + 1) };
    rejects(baseSpec({ quiz: quiz2 }), 'quiz[0].explanation', 'at most');

    const quiz3 = baseSpec().quiz;
    quiz3[0] = { ...quiz3[0], conceptTag: 'x'.repeat(PRACTICE_LIMITS.conceptTagMaxChars + 1) };
    rejects(baseSpec({ quiz: quiz3 }), 'quiz[0].conceptTag', 'at most');
  });

  it('rejects a hallucinated citation rather than repairing it', () => {
    // Unlike the quiz path, which repairs: there is no validated answer key
    // here worth salvaging, so a wrong citation regenerates instead.
    rejects(baseSpec({ citations: ['chunk-a', 'chunk-invented'] }), 'chunk-invented', 'chunkid');
  });

  it('rejects too few or too many citations', () => {
    rejects(baseSpec({ citations: [] }), 'citations', '1 to 6');
    rejects(baseSpec({ citations: Array.from({ length: 7 }, () => 'chunk-a') }), 'citations', '1 to 6');
  });

  it('de-duplicates repeated citations', () => {
    const spec = validatePracticeSetSpec(
      baseSpec({ citations: ['chunk-a', 'chunk-a', 'chunk-b'] }),
      { knownChunkIds: KNOWN }
    );
    assert.deepEqual(spec.citations, ['chunk-a', 'chunk-b']);
  });

  it('rejects every citation when no chunk ids are supplied', () => {
    // An empty knownChunkIds means no grounding chunks were given to the
    // model, so any citation it names is unsupported by definition — it must
    // be rejected, not silently accepted.
    assert.throws(
      () => validatePracticeSetSpec(baseSpec({ citations: ['anything'] }), {}),
      PracticeValidationError
    );
  });

  it('collects every human-visible string for the safety pass', () => {
    const text = collectPracticeSetText(baseSpec());
    assert.ok(text.includes('Photosynthesis'));
    assert.ok(text.includes('chloroplasts of plant cells'));
    assert.ok(text.includes('Oxygen'));
  });
});
