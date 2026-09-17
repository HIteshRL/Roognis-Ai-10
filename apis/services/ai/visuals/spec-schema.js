/**
 * JSON Schemas for visual specs — SHAPE ONLY.
 *
 * These describe key names, types and required-ness. They deliberately carry no
 * `minItems`, `maxItems`, `minimum`, `maximum` or `pattern`, because OpenAI
 * strict `json_schema` mode ignores or outright rejects those keywords. A
 * schema here that claimed `maxItems: 20` would be enforcing nothing while
 * looking like it enforced something.
 *
 * Every bound lives in spec-validate.js, which is also what drives the
 * self-correcting retry in structured-llm.js.
 *
 * Strict mode additionally requires `additionalProperties: false` at every
 * level and every property listed in `required` — including ones that may be
 * empty, which is why `edges[].label` is required rather than optional.
 */

const conceptMapSpecSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'nodes', 'edges', 'citations'],
  properties: {
    title: {
      type: 'string',
      description: 'Short title naming what the map is about.',
    },
    nodes: {
      type: 'array',
      description: 'The ideas in the map. Each needs a stable id and a short human label.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: {
          id: {
            type: 'string',
            description: 'Lowercase slug, letters/digits/hyphen/underscore only, unique within the map.',
          },
          label: {
            type: 'string',
            description: 'Short human-readable name for the idea.',
          },
        },
      },
    },
    edges: {
      type: 'array',
      description: 'Directed relationships between nodes, pointing from the more general idea to the more specific.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label'],
        properties: {
          from: { type: 'string', description: 'id of the source node.' },
          to: { type: 'string', description: 'id of the target node.' },
          label: {
            type: 'string',
            description: 'Very short relationship word, or an empty string when none is needed.',
          },
        },
      },
    },
    citations: {
      type: 'array',
      description: 'chunkId values from the supplied chapter context that this map was built from.',
      items: { type: 'string' },
    },
  },
};

module.exports = {
  conceptMapSpecSchema,
};
