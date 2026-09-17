/**
 * Bounds checking for practice-set specs (summary + flashcards + quiz).
 *
 * Same two jobs as services/ai/visuals/spec-validate.js, which this mirrors:
 * keep a malformed spec out of storage, and *be the retry prompt* —
 * structured-llm.js hands the thrown message straight back to the model as
 * its correction turn, so every message names the offending field, what was
 * wrong, and the actual bound.
 *
 * MCQ-only, deliberately: no fuzzy short-answer matching exists in this
 * service (services/quiz/lib/scoring.js's matcher isn't worth duplicating
 * across a service boundary for a first cut — see scoring.js and HANDOFF.md).
 */

const { conceptIdForTag } = require('./concept-id');

const PRACTICE_LIMITS = {
  summaryTitleMaxChars: 80,
  summaryBodyMinChars: 40,
  summaryBodyMaxChars: 700,
  minFlashcards: 4,
  maxFlashcards: 10,
  flashcardFrontMaxChars: 100,
  flashcardBackMaxChars: 240,
  minQuizQuestions: 4,
  maxQuizQuestions: 10,
  quizPromptMaxChars: 220,
  quizOptionMaxChars: 90,
  quizExplanationMaxChars: 260,
  conceptTagMaxChars: 60,
  minCitations: 1,
  maxCitations: 6,
  citationMaxChars: 120,
};

/** "all of the above" etc. — a technically-valid MCQ option that isn't a real distractor. */
const WEAK_MCQ_OPTION_PATTERNS = [
  /^(?:all|none) of the above[.!]?$/i,
  /^(?:all|none) of these[.!]?$/i,
  /^(?:both|either) [a-d](?: and| or) [a-d][.!]?$/i,
];

class PracticeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PracticeValidationError';
  }
}

function fail(message) {
  throw new PracticeValidationError(message);
}

function requireString(value, field, { min = 1, max } = {}) {
  if (typeof value !== 'string') {
    fail(`${field} must be a string, got ${value === null ? 'null' : typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    fail(`${field} must not be empty.`);
  }
  if (max !== undefined && trimmed.length > max) {
    fail(`${field} must be at most ${max} characters, got ${trimmed.length}. Shorten it.`);
  }
  return trimmed;
}

function requireArray(value, field, { min, max } = {}) {
  if (!Array.isArray(value)) {
    fail(`${field} must be an array, got ${value === null ? 'null' : typeof value}.`);
  }
  if (value.length < min || value.length > max) {
    fail(`${field} must contain ${min} to ${max} entries, got ${value.length}.`);
  }
  return value;
}

/**
 * Validate a practice-set spec.
 *
 * `knownChunkIds` is the set of chunkIds handed to the model. Citations
 * outside it are hallucinated and rejected rather than repaired — same
 * reasoning as validateConceptMapSpec: there is no answer key worth salvaging
 * by silently swapping a citation, so a wrong one regenerates instead.
 *
 * Throws PracticeValidationError. Returns the normalized spec (with
 * server-assigned ids) on success.
 */
function validatePracticeSetSpec(spec, { knownChunkIds = [] } = {}) {
  const L = PRACTICE_LIMITS;

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('The response must be a JSON object with summary, flashcards, quiz and citations.');
  }

  if (!spec.summary || typeof spec.summary !== 'object' || Array.isArray(spec.summary)) {
    fail('summary must be an object with title and body.');
  }
  const summaryTitle = requireString(spec.summary.title, 'summary.title', { max: L.summaryTitleMaxChars });
  const summaryBody = requireString(spec.summary.body, 'summary.body', {
    min: L.summaryBodyMinChars,
    max: L.summaryBodyMaxChars,
  });

  const rawFlashcards = requireArray(spec.flashcards, 'flashcards', {
    min: L.minFlashcards,
    max: L.maxFlashcards,
  });
  const flashcards = rawFlashcards.map((card, index) => {
    const where = `flashcards[${index}]`;
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      fail(`${where} must be an object with front and back.`);
    }
    const front = requireString(card.front, `${where}.front`, { max: L.flashcardFrontMaxChars });
    const back = requireString(card.back, `${where}.back`, { max: L.flashcardBackMaxChars });
    // Existing generated sets predate the field, so use the front as a stable
    // fallback. New generations are required by schema/prompt to name it.
    const conceptTag = typeof card.conceptTag === 'string' && card.conceptTag.trim()
      ? requireString(card.conceptTag, `${where}.conceptTag`, { max: L.conceptTagMaxChars })
      : front;
    return { id: `f${index + 1}`, front, back, conceptTag, conceptId: conceptIdForTag(conceptTag) };
  });

  const rawQuiz = requireArray(spec.quiz, 'quiz', {
    min: L.minQuizQuestions,
    max: L.maxQuizQuestions,
  });
  const quiz = rawQuiz.map((question, index) => {
    const where = `quiz[${index}]`;
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      fail(`${where} must be an object with prompt, options, correctAnswer, explanation and conceptTag.`);
    }
    const prompt = requireString(question.prompt, `${where}.prompt`, { max: L.quizPromptMaxChars });

    const rawOptions = requireArray(question.options, `${where}.options`, { min: 4, max: 4 });
    const seenOptions = new Set();
    const options = rawOptions.map((option, optionIndex) => {
      const optionField = `${where}.options[${optionIndex}]`;
      const value = requireString(option, optionField, { max: L.quizOptionMaxChars });
      if (WEAK_MCQ_OPTION_PATTERNS.some(pattern => pattern.test(value))) {
        fail(`${optionField} is "${value}", which is not a real distractor. Write four options that each stand on their own.`);
      }
      const normalized = value.toLowerCase();
      if (seenOptions.has(normalized)) {
        fail(`${where}.options has a duplicate value "${value}". All four options must be distinct.`);
      }
      seenOptions.add(normalized);
      return value;
    });

    const correctAnswer = requireString(question.correctAnswer, `${where}.correctAnswer`, { max: L.quizOptionMaxChars });
    if (!options.includes(correctAnswer)) {
      fail(`${where}.correctAnswer "${correctAnswer}" must exactly match one of ${where}.options.`);
    }

    const explanation = requireString(question.explanation, `${where}.explanation`, { max: L.quizExplanationMaxChars });
    const conceptTag = requireString(question.conceptTag, `${where}.conceptTag`, { max: L.conceptTagMaxChars });

    return {
      id: `q${index + 1}`,
      prompt,
      options,
      correctAnswer,
      explanation,
      conceptTag,
      conceptId: conceptIdForTag(conceptTag),
      misconceptionIds: [],
    };
  });

  const rawCitations = requireArray(spec.citations, 'citations', {
    min: L.minCitations,
    max: L.maxCitations,
  });
  const known = new Set(knownChunkIds);
  const citations = [];
  rawCitations.forEach((value, index) => {
    const citation = requireString(value, `citations[${index}]`, { max: L.citationMaxChars });
    // No `known.size &&` guard: an empty knownChunkIds means no grounding
    // chunks were supplied, so every citation is by definition unsupported
    // and must be rejected — see the same fix in services/ai/visuals/spec-validate.js.
    if (!known.has(citation)) {
      fail(
        `citations[${index}] is "${citation}", which is not one of the chunkId values supplied in the chapter ` +
        'context. Cite only the chunkIds you were given.'
      );
    }
    if (!citations.includes(citation)) citations.push(citation);
  });

  return {
    summary: { title: summaryTitle, body: summaryBody },
    flashcards,
    quiz,
    citations,
  };
}

/** Every human-visible string in a practice-set spec, for the safety pass. */
function collectPracticeSetText(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const parts = [spec.summary?.title, spec.summary?.body];
  for (const card of Array.isArray(spec.flashcards) ? spec.flashcards : []) {
    parts.push(card?.front, card?.back, card?.conceptTag);
  }
  for (const question of Array.isArray(spec.quiz) ? spec.quiz : []) {
    parts.push(question?.prompt, question?.explanation, question?.conceptTag);
    for (const option of Array.isArray(question?.options) ? question.options : []) {
      parts.push(option);
    }
  }
  return parts.filter(part => typeof part === 'string' && part.trim()).join('. ');
}

module.exports = {
  PRACTICE_LIMITS,
  WEAK_MCQ_OPTION_PATTERNS,
  PracticeValidationError,
  validatePracticeSetSpec,
  collectPracticeSetText,
};
