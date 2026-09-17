/**
 * Generating and rendering educational visuals.
 *
 * The model's only job is extraction: read the chapter chunks it is given and
 * emit a bounded JSON structure. It never writes SVG and never places a
 * coordinate — a language model asked for `<path d="…">` produces confidently
 * wrong geometry, and a concept map is exactly the case where wrong geometry is
 * invisible until a student is confused by it. Layout and markup are
 * deterministic (graph-layout.js, render-svg.js), so the same spec renders
 * byte-identically every time and a renderer improvement reaches every artifact
 * already stored.
 *
 * Safety validation, persistence and analytics deliberately live in server.js,
 * not here: the safety helpers and the flag/event emitters are already there,
 * and the analytics literal has to be physically in server.js to satisfy the
 * both-directions assertion in services/analytics/tests/event-types.test.js.
 */
const { generateStructured } = require('../structured-llm');
const { VISUAL_KINDS } = require('./kinds');
const { conceptMapSpecSchema } = require('./spec-schema');
const { validateConceptMapSpec, CONCEPT_MAP_LIMITS } = require('./spec-validate');
const { explainerSpecSchema } = require('./explainer-schema');
const { validateExplainerSpec, EXPLAINER_LIMITS } = require('./explainer-validate');
const { layoutGraph } = require('./graph-layout');
const { renderConceptMapSvg, conceptMapAltText } = require('./render-svg');
const { renderExplainerHtml, explainerAltText } = require('./render-html');

/** Small output, so both providers can afford a correction round. */
const CONCEPT_MAP_DEFAULTS = {
  maxAttempts: 2,
  maxCompletionTokens: 2000,
  timeoutMs: 45000,
};

/**
 * An explainer carries three source fields, so it needs a far bigger budget
 * than a concept map — and three attempts rather than two, because the scan is
 * part of the validator and a first-attempt `localStorage` is a common,
 * correctable mistake rather than a failure.
 */
const EXPLAINER_DEFAULTS = {
  maxAttempts: 3,
  maxCompletionTokens: 6000,
  timeoutMs: 90000,
};

function buildConceptMapSystemPrompt() {
  return [
    'You are Roognis, a careful school teaching assistant.',
    'You build concept maps that help a school student see how the ideas in one textbook chapter fit together.',
    'Use only the chapter context provided. Never add facts that are not in it.',
    'Choose the ideas that carry the chapter, not every noun that appears in it.',
    'Arrange the map so the most general idea comes first and more specific ideas follow from it.',
    'Every edge must express a real relationship a teacher would recognise, pointing from the more general idea to the more specific one.',
    'Edge labels are optional and must be at most three words ("needs", "produces", "is a kind of"). Use an empty string when the link speaks for itself.',
    'Node labels are short noun phrases in the language of the chapter, never whole sentences.',
    'Do not include headings, page numbers, figure numbers, exercise numbers, or anything describing the layout of the book.',
    'Cite the chunkId values you actually used.',
  ].join('\n');
}

function buildConceptMapUserPrompt({ chapter, chunks, topicText, limits }) {
  const context = chunks.map((chunk, index) => [
    `SOURCE ${index + 1}`,
    `chunkId: ${chunk.chunkId}`,
    chunk.chunkType ? `type: ${chunk.chunkType}` : null,
    `text: ${chunk.text}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  const focus = topicText
    ? `Focus the map on: ${topicText}. Include only ideas that genuinely bear on it.`
    : 'Cover the chapter as a whole, picking the ideas that carry it.';

  return [
    `Chapter: ${JSON.stringify({
      subject: chapter.subject,
      grade: chapter.grade,
      chapterNumber: chapter.chapterNumber,
      chapterName: chapter.chapterName,
    })}`,
    focus,
    `Use between ${limits.minNodes} and ${limits.maxNodes} nodes, and at most ${limits.maxEdges} edges.`,
    'Every node must be connected by at least one edge. No node may link to itself.',
    `Node labels: at most ${limits.nodeLabelMaxChars} characters. Edge labels: at most ${limits.edgeLabelMaxChars} characters.`,
    `Cite between ${limits.minCitations} and ${limits.maxCitations} chunkId values from the sources below, and only from those.`,
    'Return only the JSON object.',
    '',
    'Chapter context:',
    context,
  ].join('\n');
}

/**
 * Ask the model for a concept-map spec and validate it.
 *
 * The validator is handed to `generateStructured`, so a rejection becomes the
 * next attempt's correction turn rather than a failure. That matters more here
 * than it looks: the bounds most likely to be missed (orphan nodes, an
 * unconnected id, a hallucinated citation) are all things a model fixes readily
 * when told exactly what was wrong.
 */
async function generateConceptMapSpec({ chapter, chunks, topicText, config = {}, fetchFn } = {}) {
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error('No usable chapter content was found to build a visual from.');
  }

  const knownChunkIds = chunks.map(chunk => chunk.chunkId).filter(Boolean);

  const result = await generateStructured({
    task: 'visuals',
    systemPrompt: buildConceptMapSystemPrompt(),
    userPrompt: buildConceptMapUserPrompt({ chapter, chunks, topicText, limits: CONCEPT_MAP_LIMITS }),
    schema: conceptMapSpecSchema,
    schemaName: 'concept_map_spec',
    schemaDescription: 'A grounded concept map of one textbook chapter.',
    validate: spec => validateConceptMapSpec(spec, { knownChunkIds }),
    retryInstructions: [
      'Keep using only the chapter context you were given.',
      'Do not cite a chunkId that does not appear in the sources.',
    ],
    defaults: CONCEPT_MAP_DEFAULTS,
    config,
    ...(fetchFn ? { fetchFn } : {}),
  });

  // Re-run the validator to get the normalized spec back: generateStructured
  // returns the raw parsed payload, and it is the normalized form (trimmed
  // labels, de-duplicated citations) that gets stored and rendered.
  const spec = validateConceptMapSpec(result.data, { knownChunkIds });

  return { spec, model: result.model, provider: result.provider, attempts: result.attempts };
}

function buildExplainerSystemPrompt() {
  return [
    'You are Roognis, a careful school teaching assistant.',
    'You build one small interactive explainer that helps a school student understand a single idea from one textbook chapter.',
    'Use only the chapter context provided. Never add facts that are not in it.',
    'Pick ONE idea with something a student can vary — a quantity, a position, a choice — and let them vary it and see the result. An explainer the student cannot operate is just a paragraph.',
    'Write plain browser JavaScript. No libraries, no frameworks, no build step, and nothing loaded from the internet.',
    'Draw with HTML elements, CSS and inline SVG. You cannot load an image, a font or a script from anywhere.',
    // The first real generation drew <svg width="100" height="100"> with a
    // label wider than the box, so the text was clipped on a phone. The
    // stylesheet now scales an un-sized svg, and this says it outright.
    'Give any <svg> a viewBox and width="100%" rather than a fixed pixel width — it is displayed on a phone screen about 320 pixels wide, and a fixed-width drawing gets clipped.',
    'Keep text inside the shape that contains it. A label wider than its box is cut off, not wrapped.',
    'Use the supplied CSS variables for every colour: var(--ink), var(--ink-muted), var(--surface), var(--surface-2), var(--line), var(--accent), var(--green), var(--blue), var(--amber), var(--red). Never write a literal colour — the student may be in dark mode.',
    'Label every control so it is obvious what it does, and show the current value in text as well as in the picture.',
    // The measurement boundary, stated to the model as well as enforced by the
    // scan. An explainer that scored a student would be an LLM writing into the
    // learner model by the back door (MASTERCONTEXT §7.1-2).
    'This is an explanation, never a test. Do not score the student, mark answers right or wrong, keep a total, or record anything. Nothing is saved and nothing is reported.',
    'Do not use localStorage, cookies, fetch, or any browser storage or network feature. They are blocked and the explainer will be rejected.',
    'Keep it small enough to read: one idea, a couple of controls, and a clear picture.',
    'Cite the chunkId values you actually used.',
  ].join('\n');
}

function buildExplainerUserPrompt({ chapter, chunks, topicText, limits }) {
  const context = chunks.map((chunk, index) => [
    `SOURCE ${index + 1}`,
    `chunkId: ${chunk.chunkId}`,
    chunk.chunkType ? `type: ${chunk.chunkType}` : null,
    `text: ${chunk.text}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  const focus = topicText
    ? `Build the explainer about: ${topicText}.`
    : 'Choose the one idea in this chapter that best rewards being played with.';

  return [
    `Chapter: ${JSON.stringify({
      subject: chapter.subject,
      grade: chapter.grade,
      chapterNumber: chapter.chapterNumber,
      chapterName: chapter.chapterName,
    })}`,
    focus,
    `The explainer is ${limits.minHeight}-${limits.maxHeight} pixels tall; pick the height the content needs.`,
    'html: body markup only, no <html>, <head>, <body>, <script> or <style> tags, and no onclick= style attributes.',
    'css: stylesheet body only, no <style> tag.',
    'js: script body only, no <script> tag. Attach listeners with addEventListener to ids from your html.',
    `summary: ${limits.summaryMinChars}-${limits.summaryMaxChars} characters describing what the explainer shows, for a student who cannot use it.`,
    `Cite between ${limits.minCitations} and ${limits.maxCitations} chunkId values from the sources below, and only from those.`,
    'Return only the JSON object.',
    '',
    'Chapter context:',
    context,
  ].join('\n');
}

/**
 * Ask the model for an interactive explainer and validate it.
 *
 * The validator includes the static scan, so a forbidden capability comes back
 * to the model as a correction turn naming what it used and what to do instead.
 * That is the ordinary path, not the exceptional one — a model reaching for
 * `localStorage` to remember a slider position is a reasonable instinct and a
 * cheap fix.
 */
async function generateExplainerSpec({ chapter, chunks, topicText, config = {}, fetchFn } = {}) {
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error('No usable chapter content was found to build a visual from.');
  }

  const knownChunkIds = chunks.map(chunk => chunk.chunkId).filter(Boolean);

  const result = await generateStructured({
    task: 'explainer',
    systemPrompt: buildExplainerSystemPrompt(),
    userPrompt: buildExplainerUserPrompt({ chapter, chunks, topicText, limits: EXPLAINER_LIMITS }),
    schema: explainerSpecSchema,
    schemaName: 'explainer_spec',
    schemaDescription: 'A small interactive explainer grounded in one textbook chapter.',
    validate: spec => validateExplainerSpec(spec, { knownChunkIds }),
    retryInstructions: [
      'Keep using only the chapter context you were given.',
      'Do not cite a chunkId that does not appear in the sources.',
      'Remember: no network, no storage, no scoring, and no literal colours.',
    ],
    defaults: EXPLAINER_DEFAULTS,
    config,
    ...(fetchFn ? { fetchFn } : {}),
  });

  const spec = validateExplainerSpec(result.data, { knownChunkIds });

  return { spec, model: result.model, provider: result.provider, attempts: result.attempts };
}

/**
 * How each kind turns a stored spec into something a client can show.
 *
 * A registry rather than a chain of `if (kind !== …)` branches, because there
 * are now two renderers producing two different payload shapes and a third
 * would have made the branching the bug. `payload` names the response key, so
 * the route does not have to know which kinds are SVG and which are documents.
 */
const RENDERERS = {
  [VISUAL_KINDS.CONCEPT_MAP]: {
    payload: 'svg',
    render: ({ id, spec }) => renderConceptMapSvg(layoutGraph(spec), {
      artifactId: id,
      title: spec.title,
      altText: conceptMapAltText(spec),
    }),
    describe: ({ spec }) => conceptMapAltText(spec),
  },
  [VISUAL_KINDS.EXPLAINER]: {
    payload: 'html',
    render: ({ spec, theme }) => renderExplainerHtml(spec, { theme }),
    describe: ({ spec }) => explainerAltText(spec),
  },
};

/** Which response key a kind's rendered output belongs under. */
function visualPayloadKey(kind) {
  return RENDERERS[kind]?.payload || null;
}

/**
 * Render a stored artifact.
 *
 * Called on read rather than at generation time, so improvements to the layout,
 * the renderer or the scan apply retroactively to everything already generated.
 */
function renderVisual({ id, kind, spec, theme = '' }) {
  const renderer = RENDERERS[kind];
  if (!renderer) {
    throw new Error(`No renderer for visual kind "${kind}".`);
  }
  return renderer.render({ id, spec, theme });
}

/** The plain-text equivalent a client can show beside the figure. */
function describeVisual({ kind, spec }) {
  const renderer = RENDERERS[kind];
  if (!renderer) return '';
  return renderer.describe({ spec });
}

/** Which generator a kind uses. Keyed the same way as RENDERERS, on purpose. */
const GENERATORS = {
  [VISUAL_KINDS.CONCEPT_MAP]: generateConceptMapSpec,
  [VISUAL_KINDS.EXPLAINER]: generateExplainerSpec,
};

/**
 * Generate the spec for one kind.
 *
 * The job runner calls this rather than naming a generator, so adding a kind is
 * a registry entry instead of another branch in server.js.
 */
async function generateVisualSpec({ kind, chapter, chunks, topicText, config = {}, fetchFn } = {}) {
  const generate = GENERATORS[kind];
  if (!generate) {
    throw new Error(`No generator for visual kind "${kind}".`);
  }
  return generate({ chapter, chunks, topicText, config, ...(fetchFn ? { fetchFn } : {}) });
}

module.exports = {
  CONCEPT_MAP_DEFAULTS,
  EXPLAINER_DEFAULTS,
  buildConceptMapSystemPrompt,
  buildConceptMapUserPrompt,
  buildExplainerSystemPrompt,
  buildExplainerUserPrompt,
  generateConceptMapSpec,
  generateExplainerSpec,
  generateVisualSpec,
  visualPayloadKey,
  renderVisual,
  describeVisual,
};
