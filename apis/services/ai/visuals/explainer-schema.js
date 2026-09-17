/**
 * JSON Schema for an interactive explainer — SHAPE ONLY.
 *
 * Same discipline as spec-schema.js and for the same reason: OpenAI strict
 * `json_schema` mode ignores `minLength`/`maxLength`/`minimum`/`maximum`/
 * `pattern`, so a bound written here would enforce nothing while looking like
 * it enforced something. Every bound lives in explainer-validate.js, and every
 * safety rule in explainer-scan.js.
 *
 * The three source fields are separate rather than one blob on purpose. It lets
 * the scan apply the right rule set to each (an `on*=` attribute is only
 * meaningful in markup; `eval` only in script), and it means render-html.js
 * decides where each one lands in the document rather than the model deciding.
 */

const explainerSpecSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'html', 'css', 'js', 'height', 'citations'],
  properties: {
    title: {
      type: 'string',
      description: 'Short title naming the idea the explainer demonstrates.',
    },
    summary: {
      type: 'string',
      description:
        'Two or three sentences a student can read instead of operating the explainer. This is the text ' +
        'alternative, so it must describe what the explainer shows, not how to click it.',
    },
    html: {
      type: 'string',
      description:
        'Body markup only — no <html>, <head>, <body>, <script> or <style> tags, and no event handler ' +
        'attributes. Use ordinary elements with ids and classes; wire behaviour up in the js field.',
    },
    css: {
      type: 'string',
      description:
        'Stylesheet body, without a <style> tag. Use the supplied CSS variables (var(--ink), ' +
        'var(--surface), var(--accent) and so on) for every colour rather than literal values.',
    },
    js: {
      type: 'string',
      description:
        'Script body, without a <script> tag. Plain browser JavaScript operating only on elements it ' +
        'creates or finds in the html field. No network access, no storage, no timers driving audio.',
    },
    height: {
      type: 'integer',
      description: 'Height of the explainer in CSS pixels. Pick what the content needs.',
    },
    citations: {
      type: 'array',
      description: 'chunkId values from the supplied chapter context this explainer was built from.',
      items: { type: 'string' },
    },
  },
};

module.exports = {
  explainerSpecSchema,
};
