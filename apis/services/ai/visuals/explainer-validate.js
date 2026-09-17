/**
 * Bounds checking for interactive explainer specs.
 *
 * Same two jobs as spec-validate.js — keep a malformed spec out of the
 * renderer, and *be the retry prompt*, because structured-llm.js hands the
 * thrown message straight back to the model as its correction turn. Every
 * message names the field, the problem and the actual bound.
 *
 * The scan (explainer-scan.js) runs as part of this, so a spec that reaches for
 * a forbidden capability is a rejection the model can correct, rather than a
 * silent failure at render time.
 */
const { scanExplainerSource } = require('./explainer-scan');

const EXPLAINER_LIMITS = {
  titleMaxChars: 80,
  summaryMinChars: 40,
  summaryMaxChars: 400,
  htmlMaxChars: 6000,
  cssMaxChars: 4000,
  jsMaxChars: 6000,
  minHeight: 240,
  maxHeight: 720,
  minCitations: 1,
  maxCitations: 6,
};

class ExplainerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExplainerValidationError';
  }
}

function fail(message) {
  throw new ExplainerValidationError(message);
}

function requireString(value, field, { min = 1, max }) {
  if (typeof value !== 'string') {
    fail(`${field} must be a string, got ${value === null ? 'null' : typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    fail(
      min === 1
        ? `${field} must not be empty.`
        : `${field} must be at least ${min} characters, got ${trimmed.length}.`
    );
  }
  if (max !== undefined && trimmed.length > max) {
    fail(`${field} must be at most ${max} characters, got ${trimmed.length}. Shorten it.`);
  }
  return trimmed;
}

/**
 * Validate an explainer spec.
 *
 * `knownChunkIds` is the set of chunkIds handed to the model; citations outside
 * it are rejected rather than repaired, for the same reason as a concept map —
 * there is no answer key worth salvaging, and a wrong citation is worse than a
 * regenerated explainer.
 *
 * Throws ExplainerValidationError (or ExplainerScanError). Returns the
 * normalized spec on success.
 */
function validateExplainerSpec(spec, { knownChunkIds = [] } = {}) {
  const L = EXPLAINER_LIMITS;

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('The response must be a JSON object with title, summary, html, css, js, height and citations.');
  }

  const title = requireString(spec.title, 'title', { max: L.titleMaxChars });

  // The summary is the text alternative, not decoration: a student who cannot
  // operate the widget reads this instead. A one-word summary would pass a
  // non-empty check and fail the student, so it carries a real floor.
  const summary = requireString(spec.summary, 'summary', {
    min: L.summaryMinChars,
    max: L.summaryMaxChars,
  });

  const html = requireString(spec.html, 'html', { max: L.htmlMaxChars });
  const js = requireString(spec.js, 'js', { max: L.jsMaxChars });

  // Legitimately empty — an explainer can lean entirely on the supplied tokens
  // and default element styling — so it is length-checked without a floor.
  if (typeof spec.css !== 'string') {
    fail(`css must be a string, got ${spec.css === null ? 'null' : typeof spec.css}.`);
  }
  const css = spec.css.trim();
  if (css.length > L.cssMaxChars) {
    fail(`css must be at most ${L.cssMaxChars} characters, got ${css.length}. Shorten it.`);
  }

  if (!Number.isInteger(spec.height)) {
    fail(`height must be a whole number of pixels, got ${JSON.stringify(spec.height)}.`);
  }
  if (spec.height < L.minHeight || spec.height > L.maxHeight) {
    fail(`height must be between ${L.minHeight} and ${L.maxHeight} pixels, got ${spec.height}.`);
  }
  const height = spec.height;

  // An explainer whose markup declares no anchor for its own script is almost
  // always a model that wrote the js against elements it forgot to create.
  if (!/\bid\s*=\s*["'][^"']+["']/.test(html)) {
    fail(
      'html contains no element with an id, so the js field has nothing to attach to. Give the elements the ' +
      'script needs an id.'
    );
  }

  // The safety boundary is the sandbox, but a spec that reaches for a forbidden
  // capability is thrown away rather than shipped, and the model is told why.
  scanExplainerSource({ html, css, js });

  if (!Array.isArray(spec.citations)) {
    fail(`citations must be an array, got ${spec.citations === null ? 'null' : typeof spec.citations}.`);
  }
  if (spec.citations.length < L.minCitations || spec.citations.length > L.maxCitations) {
    fail(`citations must contain ${L.minCitations} to ${L.maxCitations} entries, got ${spec.citations.length}.`);
  }
  const known = new Set(knownChunkIds);
  const citations = [];
  spec.citations.forEach((value, index) => {
    const citation = requireString(value, `citations[${index}]`, { max: 120 });
    // No `known.size &&` guard: an empty knownChunkIds means no grounding
    // chunks were supplied, so every citation is by definition unsupported
    // and must be rejected — see the same fix in spec-validate.js.
    if (!known.has(citation)) {
      fail(
        `citations[${index}] is "${citation}", which is not one of the chunkId values supplied in the chapter ` +
        'context. Cite only the chunkIds you were given.'
      );
    }
    if (!citations.includes(citation)) citations.push(citation);
  });

  return { title, summary, html, css, js, height, citations };
}

/**
 * Every human-visible string in an explainer spec, for the safety pass.
 *
 * Deliberately title + summary + the text between the markup's tags, and
 * deliberately NOT the raw js or css. Source code through a prose safety rule
 * set is a false-positive generator (`kill`, `abort`, `execute`, `dead` are all
 * ordinary programming words), and a check that cries wolf on every third
 * explainer gets weakened until it stops working. What a student actually reads
 * is the markup's text, and that is what is checked.
 */
function collectExplainerText(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const parts = [spec.title, spec.summary];

  if (typeof spec.html === 'string') {
    const visible = spec.html
      // Attribute values a student can read — placeholder, title, alt, value,
      // aria-label. Everything else in a tag is machinery.
      .replace(/<[^>]*\b(?:placeholder|title|alt|aria-label|value)\s*=\s*"([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (visible) parts.push(visible);
  }

  return parts.filter(part => typeof part === 'string' && part.trim()).join('. ');
}

module.exports = {
  EXPLAINER_LIMITS,
  ExplainerValidationError,
  validateExplainerSpec,
  collectExplainerText,
};
