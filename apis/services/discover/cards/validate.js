/**
 * Hand-written bounds + reject-not-repair validation for an academic card.
 *
 * Forked from services/practice/validate.js — same shape (throw a typed
 * error naming the field and the bound, so the thrown message can be fed
 * back as the model's own correction turn by generateStructured()).
 */
const CARD_LIMITS = {
  hookMin: 10, hookMax: 140,
  bodyMin: 40, bodyMax: 480,
  questionMin: 8, questionMax: 240,
  optionCount: 4,
  optionMin: 1, optionMax: 120,
  explanationMin: 20, explanationMax: 320,
  conceptTagMin: 2, conceptTagMax: 80,
  citationsMax: 4,
  // micro-article bounds — headline is a character count like every field
  // above, but body is bounded by *word* count, not character count (this is
  // the one field in this file measured that way; see countWords below).
  headlineMin: 10, headlineMax: 100,
  bodyWordsMin: 90, bodyWordsMax: 170,
  ctaTypes: ['tutor', 'practice'],
};

const WEAK_MCQ_OPTION_PATTERNS = [
  /^all of the above$/i,
  /^none of the above$/i,
  /^both a and b$/i,
];

class AcademicCardValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcademicCardValidationError';
  }
}

function fail(message) {
  throw new AcademicCardValidationError(message);
}

function requireString(value, field, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') fail(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < min) fail(`${field} must be at least ${min} characters.`);
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters.`);
  return trimmed;
}

function requireArray(value, field, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  if (value.length < min) fail(`${field} must have at least ${min} items.`);
  if (value.length > max) fail(`${field} must have at most ${max} items.`);
  return value;
}

/** Whitespace-delimited word count — every other bound in this file counts characters; this one deliberately doesn't. */
function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function requireWordCountString(value, field, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') fail(`${field} must be a string.`);
  const trimmed = value.trim();
  const words = countWords(trimmed);
  if (words < min) fail(`${field} must be at least ${min} words.`);
  if (words > max) fail(`${field} must be at most ${max} words.`);
  return trimmed;
}

/**
 * @param {object} spec - raw model output matching academicCardSchema
 * @param {object} opts
 * @param {Set<string>} opts.knownChunkIds - citations must be a subset of this;
 *   an unknown citation is a reject-not-repair failure, not silently dropped.
 */
function validateAcademicCardSpec(spec, { knownChunkIds } = {}) {
  if (!spec || typeof spec !== 'object') fail('Card spec must be an object.');

  const hook = requireString(spec.hook, 'hook', { min: CARD_LIMITS.hookMin, max: CARD_LIMITS.hookMax });
  const body = requireString(spec.body, 'body', { min: CARD_LIMITS.bodyMin, max: CARD_LIMITS.bodyMax });
  const question = requireString(spec.question, 'question', { min: CARD_LIMITS.questionMin, max: CARD_LIMITS.questionMax });

  const rawOptions = requireArray(spec.options, 'options', {
    min: CARD_LIMITS.optionCount, max: CARD_LIMITS.optionCount,
  });
  const options = rawOptions.map((option, index) => requireString(option, `options[${index}]`, {
    min: CARD_LIMITS.optionMin, max: CARD_LIMITS.optionMax,
  }));
  const distinct = new Set(options.map(option => option.toLowerCase()));
  if (distinct.size !== options.length) fail('options must be distinct.');
  for (const option of options) {
    if (WEAK_MCQ_OPTION_PATTERNS.some(pattern => pattern.test(option))) {
      fail(`options must not use a catch-all like "${option}".`);
    }
  }

  const correctAnswer = requireString(spec.correctAnswer, 'correctAnswer', { min: CARD_LIMITS.optionMin, max: CARD_LIMITS.optionMax });
  if (!options.some(option => option.toLowerCase() === correctAnswer.toLowerCase())) {
    fail('correctAnswer must match one of options exactly.');
  }

  const explanation = requireString(spec.explanation, 'explanation', {
    min: CARD_LIMITS.explanationMin, max: CARD_LIMITS.explanationMax,
  });
  const conceptTag = requireString(spec.conceptTag, 'conceptTag', {
    min: CARD_LIMITS.conceptTagMin, max: CARD_LIMITS.conceptTagMax,
  });

  const rawCitations = requireArray(spec.citations, 'citations', { min: 1, max: CARD_LIMITS.citationsMax });
  const citations = rawCitations.map((citation, index) => requireString(citation, `citations[${index}]`, { min: 1, max: 200 }));
  if (knownChunkIds) {
    for (const citation of citations) {
      if (!knownChunkIds.has(citation)) {
        fail(`citations[] value "${citation}" does not match a chunk id supplied for grounding — do not invent citations.`);
      }
    }
  }

  return {
    hook, body, question, options, correctAnswer, explanation, conceptTag,
    citations: [...new Set(citations)],
  };
}

/** Flatten all human-visible strings for the safety pass. */
function collectAcademicCardText(spec) {
  if (!spec) return '';
  return [
    spec.hook, spec.body, spec.question,
    ...(Array.isArray(spec.options) ? spec.options : []),
    spec.correctAnswer, spec.explanation, spec.conceptTag,
  ].filter(part => typeof part === 'string').join('\n');
}

/**
 * @param {object} spec - raw model output matching microArticleSchema
 * @param {object} opts
 * @param {Set<string>} opts.knownChunkIds - citations must be a subset of this;
 *   an unknown citation is a reject-not-repair failure, not silently dropped.
 */
function validateMicroArticleSpec(spec, { knownChunkIds } = {}) {
  if (!spec || typeof spec !== 'object') fail('Article spec must be an object.');

  const headline = requireString(spec.headline, 'headline', {
    min: CARD_LIMITS.headlineMin, max: CARD_LIMITS.headlineMax,
  });
  const body = requireWordCountString(spec.body, 'body', {
    min: CARD_LIMITS.bodyWordsMin, max: CARD_LIMITS.bodyWordsMax,
  });

  const ctaType = requireString(spec.ctaType, 'ctaType', { min: 1, max: 40 });
  if (!CARD_LIMITS.ctaTypes.includes(ctaType)) {
    fail(`ctaType must be one of: ${CARD_LIMITS.ctaTypes.join(', ')}.`);
  }

  const rawCitations = requireArray(spec.citations, 'citations', { min: 1, max: CARD_LIMITS.citationsMax });
  const citations = rawCitations.map((citation, index) => requireString(citation, `citations[${index}]`, { min: 1, max: 200 }));
  if (knownChunkIds) {
    for (const citation of citations) {
      if (!knownChunkIds.has(citation)) {
        fail(`citations[] value "${citation}" does not match a chunk id supplied for grounding — do not invent citations.`);
      }
    }
  }

  return {
    headline, body, ctaType,
    citations: [...new Set(citations)],
  };
}

/** Flatten all human-visible strings for the safety pass — the micro-article sibling of collectAcademicCardText. */
function collectMicroArticleText(spec) {
  if (!spec) return '';
  return [spec.headline, spec.body].filter(part => typeof part === 'string').join('\n');
}

module.exports = {
  CARD_LIMITS,
  WEAK_MCQ_OPTION_PATTERNS,
  AcademicCardValidationError,
  fail,
  requireString,
  requireArray,
  countWords,
  requireWordCountString,
  validateAcademicCardSpec,
  collectAcademicCardText,
  validateMicroArticleSpec,
  collectMicroArticleText,
};
