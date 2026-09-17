/**
 * Shape-only JSON Schema for a practice set: {summary, flashcards[], quiz[]}.
 *
 * Shape only, per structured-llm.js's own rule — OpenAI/OpenRouter strict mode
 * ignores minItems/maxItems/minimum/pattern, so every bound lives in
 * validate.js instead. additionalProperties:false throughout, required by
 * OpenAI strict mode.
 */
const practiceSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'flashcards', 'quiz', 'citations'],
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
    flashcards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['front', 'back', 'conceptTag'],
        properties: {
          front: { type: 'string' },
          back: { type: 'string' },
          conceptTag: { type: 'string' },
        },
      },
    },
    quiz: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'options', 'correctAnswer', 'explanation', 'conceptTag'],
        properties: {
          prompt: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctAnswer: { type: 'string' },
          explanation: { type: 'string' },
          conceptTag: { type: 'string' },
        },
      },
    },
    citations: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

module.exports = { practiceSetSchema };
