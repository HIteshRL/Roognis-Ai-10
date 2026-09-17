'use strict';
// cards/validate.js — hand-written bounds + reject-not-repair validation for
// both academic-card shapes. No test file existed for this module before
// this session (workstream 4 added the micro-article half), so the MCQ side
// (validateAcademicCardSpec) is covered here too, not just the new path.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CARD_LIMITS,
  AcademicCardValidationError,
  countWords,
  validateAcademicCardSpec,
  validateMicroArticleSpec,
} = require('../cards/validate');

function words(n, prefix = 'word') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

// ── countWords ─────────────────────────────────────────────────────────────

test('countWords splits on whitespace and ignores empty tokens', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  padded   with   extra   spaces  '), 4);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(undefined), 0);
});

// ── validateAcademicCardSpec (MCQ card) ──────────────────────────────────────

function validMcqSpec(overrides = {}) {
  return {
    hook: 'A curious fact about volcanoes',
    body: 'Volcanoes form where magma reaches the surface. Some erupt violently.',
    question: 'What causes a volcano to form?',
    options: ['Magma reaching the surface', 'Ocean currents', 'Wind erosion', 'Tectonic cooling'],
    correctAnswer: 'Magma reaching the surface',
    explanation: 'Magma rising through the crust is what builds a volcano over time.',
    conceptTag: 'volcanism',
    citations: ['chunk-1'],
    ...overrides,
  };
}

test('validateAcademicCardSpec accepts a well-formed spec and trims strings', () => {
  const out = validateAcademicCardSpec(validMcqSpec({ hook: '  A curious fact about volcanoes  ' }), {
    knownChunkIds: new Set(['chunk-1']),
  });
  assert.equal(out.hook, 'A curious fact about volcanoes');
  assert.equal(out.correctAnswer, 'Magma reaching the surface');
  assert.deepEqual(out.citations, ['chunk-1']);
});

test('validateAcademicCardSpec rejects a non-object spec', () => {
  assert.throws(() => validateAcademicCardSpec(null), AcademicCardValidationError);
  assert.throws(() => validateAcademicCardSpec('nope'), AcademicCardValidationError);
});

test('validateAcademicCardSpec enforces hook bounds', () => {
  assert.throws(() => validateAcademicCardSpec(validMcqSpec({ hook: 'short' })), /hook must be at least/);
  assert.throws(() => validateAcademicCardSpec(validMcqSpec({ hook: 'x'.repeat(CARD_LIMITS.hookMax + 1) })), /hook must be at most/);
});

test('validateAcademicCardSpec requires exactly 4 distinct options', () => {
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ options: ['A', 'B', 'C'] })),
    /options must have at least 4 items/,
  );
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ options: ['A', 'A', 'B', 'C'] })),
    /options must be distinct/,
  );
});

test('validateAcademicCardSpec rejects a catch-all option', () => {
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ options: ['All of the above', 'B', 'C', 'D'] })),
    /must not use a catch-all/,
  );
});

test('validateAcademicCardSpec requires correctAnswer to match an option exactly (case-insensitive)', () => {
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ correctAnswer: 'Not an option' })),
    /correctAnswer must match one of options/,
  );
  const out = validateAcademicCardSpec(validMcqSpec({ correctAnswer: 'MAGMA REACHING THE SURFACE' }));
  assert.equal(out.correctAnswer, 'MAGMA REACHING THE SURFACE');
});

test('validateAcademicCardSpec bounds citations to 1-4 and de-duplicates', () => {
  assert.throws(() => validateAcademicCardSpec(validMcqSpec({ citations: [] })), /citations must have at least 1/);
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ citations: ['a', 'b', 'c', 'd', 'e'] })),
    /citations must have at most 4/,
  );
  const out = validateAcademicCardSpec(validMcqSpec({ citations: ['dup', 'dup'] }));
  assert.deepEqual(out.citations, ['dup']);
});

test('validateAcademicCardSpec rejects a citation not in knownChunkIds — reject, not repair', () => {
  assert.throws(
    () => validateAcademicCardSpec(validMcqSpec({ citations: ['invented-chunk'] }), { knownChunkIds: new Set(['chunk-1']) }),
    /does not match a chunk id supplied for grounding/,
  );
});

// ── validateMicroArticleSpec ──────────────────────────────────────────────────

function validMicroArticleSpec(overrides = {}) {
  return {
    headline: 'Why volcanoes form where they do',
    body: words(120),
    ctaType: 'tutor',
    citations: ['chunk-1'],
    ...overrides,
  };
}

test('validateMicroArticleSpec accepts a well-formed spec', () => {
  const out = validateMicroArticleSpec(validMicroArticleSpec(), { knownChunkIds: new Set(['chunk-1']) });
  assert.equal(out.headline, 'Why volcanoes form where they do');
  assert.equal(out.ctaType, 'tutor');
  assert.deepEqual(out.citations, ['chunk-1']);
});

test('validateMicroArticleSpec rejects a non-object spec', () => {
  assert.throws(() => validateMicroArticleSpec(null), /must be an object/);
});

test('validateMicroArticleSpec enforces headline length bounds (10-100 chars)', () => {
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ headline: 'too short' })),
    /headline must be at least 10 characters/,
  );
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ headline: 'x'.repeat(101) })),
    /headline must be at most 100 characters/,
  );
  // Exactly at the bounds should pass.
  const atMin = validateMicroArticleSpec(validMicroArticleSpec({ headline: 'x'.repeat(10) }));
  assert.equal(atMin.headline.length, 10);
  const atMax = validateMicroArticleSpec(validMicroArticleSpec({ headline: 'x'.repeat(100) }));
  assert.equal(atMax.headline.length, 100);
});

test('validateMicroArticleSpec enforces body bounds by WORD count, not character count', () => {
  // 89 words fails, 90 passes — the exact boundary the brief calls out.
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ body: words(89) })),
    /body must be at least 90 words/,
  );
  const at90 = validateMicroArticleSpec(validMicroArticleSpec({ body: words(90) }));
  assert.equal(countWords(at90.body), 90);

  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ body: words(171) })),
    /body must be at most 170 words/,
  );
  const at170 = validateMicroArticleSpec(validMicroArticleSpec({ body: words(170) }));
  assert.equal(countWords(at170.body), 170);
});

test('validateMicroArticleSpec body bound is genuinely about words, not characters', () => {
  // A body with very few words but many characters (one giant "word") must
  // still fail on word count — proof the bound isn't secretly a character
  // count in disguise.
  const fewWordsManyChars = 'x'.repeat(2000);
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ body: fewWordsManyChars })),
    /body must be at least 90 words/,
  );
  // A body with 120 short words (well under 480 chars, which is the MCQ
  // body's character cap) must still pass — proof it isn't being measured
  // against the other shape's character bound either.
  const shortWordsEnoughCount = Array(120).fill('a').join(' ');
  assert.ok(shortWordsEnoughCount.length < CARD_LIMITS.bodyMax);
  const out = validateMicroArticleSpec(validMicroArticleSpec({ body: shortWordsEnoughCount }));
  assert.equal(countWords(out.body), 120);
});

test('validateMicroArticleSpec restricts ctaType to exactly "tutor" or "practice"', () => {
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ ctaType: 'click_here' })),
    /ctaType must be one of: tutor, practice/,
  );
  const tutor = validateMicroArticleSpec(validMicroArticleSpec({ ctaType: 'tutor' }));
  assert.equal(tutor.ctaType, 'tutor');
  const practice = validateMicroArticleSpec(validMicroArticleSpec({ ctaType: 'practice' }));
  assert.equal(practice.ctaType, 'practice');
});

test('validateMicroArticleSpec bounds citations to 1-4 and de-duplicates', () => {
  assert.throws(() => validateMicroArticleSpec(validMicroArticleSpec({ citations: [] })), /citations must have at least 1/);
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ citations: ['a', 'b', 'c', 'd', 'e'] })),
    /citations must have at most 4/,
  );
  const out = validateMicroArticleSpec(validMicroArticleSpec({ citations: ['dup', 'dup'] }));
  assert.deepEqual(out.citations, ['dup']);
});

test('validateMicroArticleSpec citations must be a subset of knownChunkIds — reject, not repair', () => {
  assert.throws(
    () => validateMicroArticleSpec(validMicroArticleSpec({ citations: ['invented-chunk'] }), {
      knownChunkIds: new Set(['chunk-1', 'chunk-2']),
    }),
    /does not match a chunk id supplied for grounding/,
  );
  const out = validateMicroArticleSpec(validMicroArticleSpec({ citations: ['chunk-2'] }), {
    knownChunkIds: new Set(['chunk-1', 'chunk-2']),
  });
  assert.deepEqual(out.citations, ['chunk-2']);
});

test('validateMicroArticleSpec skips the citation-membership check when knownChunkIds is not supplied', () => {
  const out = validateMicroArticleSpec(validMicroArticleSpec({ citations: ['anything'] }));
  assert.deepEqual(out.citations, ['anything']);
});
