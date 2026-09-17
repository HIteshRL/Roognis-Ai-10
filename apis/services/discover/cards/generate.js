/**
 * Academic card generation — same pattern as services/practice/generate.js,
 * reusing services/discover/structured-llm.js (copy #6, unmodified).
 *
 * The weak-area label itself is never handed to the model as something to
 * write about verbatim — it is passed only as internal framing so the model
 * knows which concept to extract a hook/question from. The system prompt is
 * the enforcement point for "hide the intervention, not the intelligence":
 * the model is told to write ordinary curiosity-framed Discover content, not
 * a labeled recommendation.
 */
const { academicCardSchema, microArticleSchema } = require('./schema');
const { validateAcademicCardSpec, validateMicroArticleSpec } = require('./validate');
const { generateStructured } = require('../structured-llm');

const CARD_DEFAULTS = { maxAttempts: 2, maxCompletionTokens: 1400, timeoutMs: 40000 };

function buildCardSystemPrompt() {
  return [
    'You write short, curiosity-framed academic revision cards for a student\'s discovery feed.',
    'The card must read like an ordinary interesting fact or question — never a labeled study recommendation, never a sentence like "you are weak at X" or "you got this wrong before".',
    'Ground every claim only in the supplied excerpts. Never invent a fact not present in them.',
    'citations must be chunk ids taken verbatim from the supplied excerpts — never invent one.',
    'Respond with a single JSON object matching the schema exactly.',
  ].join(' ');
}

function buildCardUserPrompt({ chapter, chunks, targetConcept }) {
  const excerpts = chunks.map((chunk, index) => (
    `[${chunk.chunkId}] (${chunk.chunkType || 'text'}) ${String(chunk.text || '').slice(0, 500)}`
  )).join('\n\n');

  return [
    `Chapter: ${chapter?.subject || 'Unknown subject'}, Grade ${chapter?.grade ?? '?'}, Chapter ${chapter?.chapterNumber ?? '?'} — ${chapter?.chapterName || ''}`.trim(),
    `Focus concept for grounding (do not name this verbatim in the card): ${targetConcept}`,
    'Excerpts (cite by the bracketed chunk id):',
    excerpts,
    'Write: a one-line hook, a short body (2-3 sentences), one multiple-choice question with exactly 4 distinct options, the correct answer, a short explanation, a concise conceptTag, and 1-4 citations from the excerpts above.',
  ].join('\n\n');
}

async function generateAcademicCard({ chapter, chunks, targetConcept, config, fetchFn }) {
  const knownChunkIds = new Set(chunks.map(chunk => chunk.chunkId).filter(Boolean));

  const result = await generateStructured({
    task: 'cards',
    systemPrompt: buildCardSystemPrompt(),
    userPrompt: buildCardUserPrompt({ chapter, chunks, targetConcept }),
    schema: academicCardSchema,
    schemaName: 'academic_card',
    schemaDescription: 'A short curiosity-framed academic revision card with one multiple-choice question.',
    validate: spec => validateAcademicCardSpec(spec, { knownChunkIds }),
    retryInstructions: [
      'Fix only the field named in the error. Keep every other field as close to your previous answer as possible.',
    ],
    defaults: CARD_DEFAULTS,
    config,
    fetchFn,
  });

  const spec = validateAcademicCardSpec(result.data, { knownChunkIds });
  return { spec, model: result.model, provider: result.provider };
}

/**
 * Same "hide the intervention, not the intelligence" voice as
 * buildCardSystemPrompt above, aimed at a short paraphrase-and-CTA article
 * instead of a hook+MCQ. The CTA is a nudge, never a literal command — it
 * should read like the natural next thing to wonder about, not a button
 * label pasted into prose.
 */
function buildMicroArticleSystemPrompt() {
  return [
    'You write short, curiosity-framed academic articles for a student\'s discovery feed.',
    'The article must read like an ordinary interesting piece of writing — never a labeled study recommendation, never a sentence like "you are weak at X" or "you got this wrong before".',
    'Ground every claim only in the supplied excerpts. Never invent a fact not present in them.',
    'citations must be chunk ids taken verbatim from the supplied excerpts — never invent one.',
    'Write a headline, then a body of 90 to 170 words that paraphrases and explains a concept from the excerpts.',
    'End the body with a natural closing thought that nudges the reader toward either asking the tutor a follow-up question or trying a related practice question — whichever fits the content better. Never phrase this as a literal command like "click here" or "tap to continue"; it should read as a genuine next thought, not an instruction.',
    'Set ctaType to "tutor" if the closing nudge is toward asking a question, or "practice" if it is toward trying a related question.',
    'Respond with a single JSON object matching the schema exactly.',
  ].join(' ');
}

function buildMicroArticleUserPrompt({ chapter, chunks, targetConcept }) {
  const excerpts = chunks.map((chunk, index) => (
    `[${chunk.chunkId}] (${chunk.chunkType || 'text'}) ${String(chunk.text || '').slice(0, 500)}`
  )).join('\n\n');

  return [
    `Chapter: ${chapter?.subject || 'Unknown subject'}, Grade ${chapter?.grade ?? '?'}, Chapter ${chapter?.chapterNumber ?? '?'} — ${chapter?.chapterName || ''}`.trim(),
    `Focus concept for grounding (do not name this verbatim in the article): ${targetConcept}`,
    'Excerpts (cite by the bracketed chunk id):',
    excerpts,
    'Write: a headline, a body of 90-170 words paraphrasing and explaining the concept above, a ctaType ("tutor" or "practice"), and 1-4 citations from the excerpts above.',
  ].join('\n\n');
}

async function generateMicroArticle({ chapter, chunks, targetConcept, config, fetchFn }) {
  const knownChunkIds = new Set(chunks.map(chunk => chunk.chunkId).filter(Boolean));

  const result = await generateStructured({
    task: 'cards',
    systemPrompt: buildMicroArticleSystemPrompt(),
    userPrompt: buildMicroArticleUserPrompt({ chapter, chunks, targetConcept }),
    schema: microArticleSchema,
    schemaName: 'micro_article',
    schemaDescription: 'A short curiosity-framed academic article of 90-170 words ending in a soft call-to-action.',
    validate: spec => validateMicroArticleSpec(spec, { knownChunkIds }),
    retryInstructions: [
      'Fix only the field named in the error. Keep every other field as close to your previous answer as possible.',
    ],
    defaults: CARD_DEFAULTS,
    config,
    fetchFn,
  });

  const spec = validateMicroArticleSpec(result.data, { knownChunkIds });
  return { spec, model: result.model, provider: result.provider };
}

module.exports = {
  CARD_DEFAULTS,
  buildCardSystemPrompt,
  buildCardUserPrompt,
  generateAcademicCard,
  buildMicroArticleSystemPrompt,
  buildMicroArticleUserPrompt,
  generateMicroArticle,
};
