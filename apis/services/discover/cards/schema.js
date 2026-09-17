/**
 * Shape-only JSON Schema for an academic card.
 *
 * "hide the intervention, not the intelligence": the model is grounded on a
 * weak area internally (see prioritize.js), but the emitted `hook`/`body`
 * must read as ordinary curiosity-framed Discover content, never a labeled
 * recommendation ("you're weak at X"). validate.js's collectAcademicCardText
 * pass is what a safety scan runs over; this file only fixes shape. Bounds
 * are enforced in validate.js, not here — OpenAI strict mode ignores
 * minLength/maxLength/minItems/maxItems/pattern.
 */
const academicCardSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hook', 'body', 'question', 'options', 'correctAnswer', 'explanation', 'conceptTag', 'citations'],
  properties: {
    hook: { type: 'string' },
    body: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    correctAnswer: { type: 'string' },
    explanation: { type: 'string' },
    conceptTag: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Shape-only JSON Schema for a micro-article card.
 *
 * Same "hide the intervention, not the intelligence" framing as
 * academicCardSchema above — the model writes an ordinary curiosity-framed
 * article, never a labeled recommendation. No question/options/correctAnswer
 * here: a micro-article has nothing to answer, only to read. Bounds (headline
 * length, body word count, ctaType enum, citation count) are enforced in
 * validate.js, not here — see the comment above for why.
 */
const microArticleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'body', 'ctaType', 'citations'],
  properties: {
    headline: { type: 'string' },
    body: { type: 'string' },
    ctaType: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
};

module.exports = { academicCardSchema, microArticleSchema };
