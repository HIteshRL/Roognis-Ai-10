/**
 * Generating a practice set: one structured-LLM call producing a summary, a
 * flashcard deck and an MCQ quiz together, all grounded in the same chapter
 * chunks.
 *
 * Same governing rule as services/ai/visuals: the model's only job is
 * extraction from the chapter context it is given. It never decides whether
 * the content is gated, never picks the cache identity, never selects which
 * chunks it saw — the caller resolves all of that server-side.
 */
const { generateStructured } = require('./structured-llm');
const { resolveConcept } = require('./concept-mapping');
const { practiceSetSchema } = require('./schema');
const { validatePracticeSetSpec, PRACTICE_LIMITS } = require('./validate');

/** Three artifact types in one call is a bigger output than a concept map; budget accordingly. */
const PRACTICE_DEFAULTS = {
  maxAttempts: 2,
  maxCompletionTokens: 3200,
  timeoutMs: 55000,
};

function buildPracticeSystemPrompt() {
  return [
    'You are Roognis, a careful school teaching assistant.',
    'You build practice content — a short summary, a flashcard deck and a multiple-choice quiz — for one textbook chapter.',
    'Use only the chapter context provided. Never add facts that are not in it.',
    'The summary is a plain-language recap of the chapter a student can read in under a minute.',
    'Flashcards test recall of one fact or term each. The front is a question or term; the back is the answer, in the language of the chapter. Set conceptTag on every flashcard to the smallest curriculum concept it tests.',
    'Quiz questions are multiple choice with exactly four options. Exactly one option is correct and must match correctAnswer exactly. The other three must be plausible, specific wrong answers — never "all of the above", "none of the above", or a combination of other options.',
    'Set conceptTag on every quiz question to the smallest useful remediation topic a teacher could act on if a student got it wrong.',
    'Do not include headings, page numbers, figure numbers, exercise numbers, or anything describing the layout of the book.',
    'Cite the chunkId values you actually used.',
  ].join('\n');
}

/**
 * The one line that carries per-student targeting into the prompt.
 *
 * Emphasis only. It names concepts the student has already missed so the
 * extraction pass spends its question slots there rather than uniformly
 * across the chapter — it is not a new fact source, and the model is told so
 * explicitly, because a concept named here that the chapter does not cover
 * must produce nothing rather than an invented question. The plan itself is
 * computed deterministically (buildConceptPriorityPlan), so the LLM never
 * decides what a student is weak at, only how to phrase content about it.
 */
function buildConceptPriorityInstruction(conceptPriority = []) {
  const labels = (Array.isArray(conceptPriority) ? conceptPriority : [])
    .map(entry => String(entry?.label || '').trim())
    .filter(Boolean);
  if (!labels.length) return null;
  return [
    `This student has recently struggled with: ${labels.join('; ')}.`,
    'Where the chapter context genuinely covers those, prefer them when choosing which facts to turn into flashcards and quiz questions.',
    'Do not invent content for any of them that the chapter context does not support, and do not mention this instruction, the student, or their past performance anywhere in the output.',
  ].join(' ');
}

function buildPracticeUserPrompt({ chapter, chunks, limits, conceptPriority = [] }) {
  const context = chunks.map((chunk, index) => [
    `SOURCE ${index + 1}`,
    `chunkId: ${chunk.chunkId}`,
    chunk.chunkType ? `type: ${chunk.chunkType}` : null,
    `text: ${chunk.text}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  return [
    `Chapter: ${JSON.stringify({
      subject: chapter.subject,
      grade: chapter.grade,
      chapterNumber: chapter.chapterNumber,
      chapterName: chapter.chapterName,
    })}`,
    `Summary title: at most ${limits.summaryTitleMaxChars} characters. Summary body: ${limits.summaryBodyMinChars} to ${limits.summaryBodyMaxChars} characters.`,
    `Write between ${limits.minFlashcards} and ${limits.maxFlashcards} flashcards, each front at most ${limits.flashcardFrontMaxChars} characters and each back at most ${limits.flashcardBackMaxChars} characters.`,
    `Write between ${limits.minQuizQuestions} and ${limits.maxQuizQuestions} quiz questions, each with exactly 4 distinct options.`,
    `Quiz prompts: at most ${limits.quizPromptMaxChars} characters. Options: at most ${limits.quizOptionMaxChars} characters each. Explanations: at most ${limits.quizExplanationMaxChars} characters.`,
    `Cite between ${limits.minCitations} and ${limits.maxCitations} chunkId values from the sources below, and only from those.`,
    buildConceptPriorityInstruction(conceptPriority),
    chapter.conceptCatalog?.length
      ? 'Reviewed concept labels: ' + JSON.stringify(chapter.conceptCatalog.slice(0, 100).map(row => row.label))
        + '. When an item measures one of these concepts, use its exact label as conceptTag. Do not force an unrelated item into a reviewed concept.'
      : '',
    chapter.academicSupport?.length
      ? 'Academic support recommendations (not answer keys or marks): ' + JSON.stringify(chapter.academicSupport.map(({ label, nextDifficulty, scaffold }) => ({ label, nextDifficulty, scaffold })))
        + '. Use these to choose practice complexity and summary scaffolding. Do not reveal quiz answers in the summary.'
      : '',
    'Return only the JSON object.',
    '',
    'Chapter context:',
    context,
  ].filter(Boolean).join('\n');
}

/**
 * Ask the model for a practice-set spec and validate it.
 *
 * The validator is handed to generateStructured, so a rejection becomes the
 * next attempt's correction turn — the bounds most likely to be missed (a
 * weak MCQ option, a correctAnswer that doesn't match any option, a
 * hallucinated citation) are all things a model fixes readily when told
 * exactly what was wrong.
 */
/**
 * How many generated items actually landed on a prioritised concept.
 *
 * Post-hoc and deterministic: analytics metadata only, never a gate. A model
 * that ignored the emphasis line still produces a valid, grounded practice
 * set — this just makes it visible when that keeps happening, rather than
 * leaving targeting a claim nobody can check.
 */
function countConceptPriorityCoverage(spec, conceptPriority = []) {
  const terms = (Array.isArray(conceptPriority) ? conceptPriority : [])
    .flatMap(entry => [entry?.label, ...(Array.isArray(entry?.conceptTags) ? entry.conceptTags : [])])
    .map(term => String(term || '').trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return 0;

  const haystacks = [
    ...(Array.isArray(spec?.flashcards) ? spec.flashcards : []).map(card => `${card?.front || ''} ${card?.back || ''}`),
    ...(Array.isArray(spec?.quiz) ? spec.quiz : []).map(question => `${question?.prompt || ''} ${question?.conceptTag || ''}`),
  ].map(text => text.toLowerCase());

  return haystacks.filter(text => terms.some(term => text.includes(term))).length;
}

async function generatePracticeSet({ chapter, chunks, conceptPriority = [], config = {}, fetchFn } = {}) {
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error('No usable chapter content was found to build practice content from.');
  }

  const knownChunkIds = chunks.map(chunk => chunk.chunkId).filter(Boolean);

  const result = await generateStructured({
    task: 'practice',
    systemPrompt: buildPracticeSystemPrompt(),
    userPrompt: buildPracticeUserPrompt({ chapter, chunks, limits: PRACTICE_LIMITS, conceptPriority }),
    schema: practiceSetSchema,
    schemaName: 'practice_set',
    schemaDescription: 'A grounded summary, flashcard deck and multiple-choice quiz for one textbook chapter.',
    validate: spec => validatePracticeSetSpec(spec, { knownChunkIds }),
    retryInstructions: [
      'Keep using only the chapter context you were given.',
      'Do not cite a chunkId that does not appear in the sources.',
      'Every quiz question needs exactly 4 distinct, specific options with correctAnswer matching one of them exactly.',
    ],
    defaults: PRACTICE_DEFAULTS,
    config,
    ...(fetchFn ? { fetchFn } : {}),
  });

  // Re-run the validator to get the normalized spec back (server-assigned
  // flashcard/question ids, de-duplicated citations) — generateStructured
  // returns the raw parsed payload.
  const spec = validatePracticeSetSpec(result.data, { knownChunkIds });
  for (const item of [...spec.flashcards, ...spec.quiz]) {
    item.conceptId = resolveConcept(item.conceptTag, { chapter });
  }

  return {
    spec,
    model: result.model,
    provider: result.provider,
    attempts: result.attempts,
    conceptPriorityCoverage: countConceptPriorityCoverage(spec, conceptPriority),
  };
}

module.exports = {
  PRACTICE_DEFAULTS,
  buildPracticeSystemPrompt,
  buildPracticeUserPrompt,
  buildConceptPriorityInstruction,
  countConceptPriorityCoverage,
  generatePracticeSet,
};
