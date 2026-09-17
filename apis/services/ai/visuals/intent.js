/**
 * Deterministic routing from a student's words to a visual kind.
 *
 * No model participates in this decision. MASTERCONTEXT §7.1 puts selection and
 * routing outside what an LLM may do, and "which visual should this student
 * get" is a selection. The shape here deliberately mirrors `isVideoRequest` in
 * video-search.js, which had to learn the same lesson the hard way: a bare
 * keyword match on "video" hijacked the tutor whenever a student *mentioned* a
 * video in passing. So a keyword alone is never enough — it has to be paired
 * with a request, or be a phrase that can only be a request.
 *
 * "The chapter has a flowchart on page 4, can you explain it?" must reach the
 * tutor, not the flowchart generator.
 */
const { VISUAL_KINDS } = require('./kinds');

/**
 * Verbs that turn a noun into a request. Kept close to the noun by the patterns
 * below (bounded character runs, stopping at sentence punctuation) so a verb in
 * a previous clause cannot reach across and trigger a match.
 */
const REQUEST_VERB = '(?:show|draw|make|create|build|generate|give|get|need|want|produce|sketch|map)';

/** Nouns that name the artifact itself. A visual request has to contain one. */
const VISUAL_NOUN = '(?:concept\\s*map|mind\\s*map|idea\\s*map|map|web|diagram|chart)';

/**
 * A visual noun paired with an actual request.
 *
 * Deliberately conservative, and it stays that way. The tempting patterns are
 * the semantic ones — "how do X and Y relate", "the relationship between X and
 * Y" — but those are *ordinary tutor questions*. A student asking "what is the
 * relationship between force and friction" wants an explanation, and routing
 * them into a diagram generator is the same defect `isVideoRequest` was written
 * to fix, just with a different noun. Students who want a map can say so or tap
 * the chip; the cost of under-triggering is one extra tap, and the cost of
 * over-triggering is a hijacked tutor.
 */
const CONCEPT_MAP_REQUESTED = [
  // "draw a concept map of X", "show me a diagram of Y"
  new RegExp(`\\b${REQUEST_VERB}\\b[^.?!]{0,30}\\b${VISUAL_NOUN}\\b`, 'i'),
  // "a concept map of X, please" — noun first, request after.
  new RegExp(`\\b${VISUAL_NOUN}\\b[^.?!]{0,20}\\b(?:please|for me)\\b`, 'i'),
  // "visualise how X works" — the verb is itself the request.
  /\bvisual(?:ise|ize)\b[^.?!]{0,30}\b(?:how|the|these|this|it)\b/i,
];

/**
 * An interactive explainer, requested unambiguously.
 *
 * Checked BEFORE the concept-map patterns, because "show me an interactive
 * diagram of levers" contains a concept-map noun and the more specific reading
 * is the right one. Order is the whole disambiguation strategy here; there is
 * no scoring between kinds and there should not be.
 *
 * The bar is higher than for a concept map, deliberately. "Interactive" alone
 * is not a request — a student writing "is friction interactive with surface
 * area" must reach the tutor. So the word has to sit next to something that
 * names a thing to build, or be part of a phrase that can only be a request.
 */
const EXPLAINER_NOUN = '(?:explainer|simulation|simulator|model|widget|demo|animation)';
const EXPLAINER_REQUESTED = [
  // "make me an interactive explainer", "build a simulation of levers"
  new RegExp(`\\b${REQUEST_VERB}\\b[^.?!]{0,30}\\b(?:interactive\\s+\\w+|${EXPLAINER_NOUN})\\b`, 'i'),
  // "an interactive diagram of X" — the adjective is doing the work, so it must
  // be adjacent to the noun rather than anywhere in the sentence.
  new RegExp(`\\binteractive\\b\\s+(?:${EXPLAINER_NOUN}|${VISUAL_NOUN})\\b`, 'i'),
  // "let me play with the pressure", "I want to try changing the angle"
  /\b(?:let me|i want to|i'd like to|can i)\b[^.?!]{0,20}\b(?:play with|experiment with|try changing|drag|slide)\b/i,
];

/** Terse explainer requests — "interactive simulation of friction". */
const EXPLAINER_TERSE = new RegExp(`^[^.?!]{0,60}\\b(?:interactive|${EXPLAINER_NOUN})\\b`, 'i');

/**
 * Terse messages that are the noun and little else — "concept map photosynthesis".
 * Bounded by word count so a passing mention ("I saw a concept map in class")
 * cannot match.
 */
const TERSE_MAX_WORDS = 5;
const CONCEPT_MAP_TERSE = new RegExp(`^[^.?!]{0,60}\\b${VISUAL_NOUN}\\b`, 'i');

/** Past-tense framing that marks a mention rather than a request. */
const MENTION_NOT_REQUEST = /\b(?:saw|seen|watched|read|found|there is|there's|has a|have a|had a)\b/i;

/**
 * Words stripped when reducing a request to the topic it is about. Mirrors the
 * REQUEST_WORDS / ACADEMIC_NOISE_WORDS split in video-search.js.
 */
const REQUEST_NOISE = new Set([
  'a', 'an', 'the', 'me', 'my', 'i', 'you', 'u', 'can', 'could', 'would', 'please',
  'show', 'draw', 'make', 'create', 'build', 'generate', 'give', 'get', 'need',
  'want', 'produce', 'sketch', 'map', 'concept', 'mind', 'idea', 'diagram',
  'chart', 'web', 'visualise', 'visualize', 'of', 'for', 'about', 'on', 'in',
  'to', 'with', 'from', 'and', 'or', 'how', 'do', 'does', 'these', 'this',
  'that', 'is', 'are', 'relate', 'relates', 'connect', 'connects', 'between',
  'among', 'relationship', 'relationships', 'connection', 'connections',
  'link', 'links', 'grade', 'class', 'chapter', 'ch', 'std', 'standard',
  // Explainer request words. Without these the request noun rides into
  // conceptSlugFor, so "simulation of friction" and "friction" would key two
  // different cache entries for the same thing.
  'interactive', 'explainer', 'simulation', 'simulator', 'widget', 'demo',
  'animation', 'play', 'experiment', 'try', 'changing', 'drag', 'slide',
]);

function normalizeIntentText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce a request to the topic it is about, for grounding and the cache slug.
 *
 * Falls back to the normalized message when stripping removes everything —
 * "draw a concept map" with no topic is still a legitimate request, it just
 * grounds on the chapter as a whole.
 */
function extractTopicText(message) {
  const normalized = normalizeIntentText(message);
  if (!normalized) return '';
  const kept = normalized.split(' ').filter(word => word && !REQUEST_NOISE.has(word));
  return kept.length ? kept.join(' ') : normalized;
}

function matchesAny(patterns, text) {
  return patterns.some(pattern => pattern.test(text));
}

/**
 * Route a message to a visual kind.
 *
 * `explicitKind` — the student tapped a chip — always wins. An explicit choice
 * is unambiguous and needs no inference; the regexes exist only for free text.
 *
 * Returns `{ kind, source, topicText }` where `source` is:
 *   'explicit' — the caller named the kind
 *   'matched'  — a pattern fired
 *   null       — no kind could be determined; `kind` is null and the caller
 *                should ask rather than guess.
 */
function routeVisualIntent(message, { explicitKind } = {}) {
  const topicText = extractTopicText(message);

  if (explicitKind) {
    const kind = String(explicitKind).trim().toLowerCase();
    if (Object.values(VISUAL_KINDS).includes(kind)) {
      return { kind, source: 'explicit', topicText };
    }
    return { kind: null, source: null, topicText };
  }

  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { kind: null, source: null, topicText };

  // A mention is not a request, whatever else the sentence contains.
  if (MENTION_NOT_REQUEST.test(text)) return { kind: null, source: null, topicText };

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Explainer first: the more specific reading wins. "Show me an interactive
  // diagram" satisfies both pattern sets, and it is an explainer request.
  const explainerTerse = wordCount <= TERSE_MAX_WORDS && EXPLAINER_TERSE.test(text);
  if (explainerTerse || matchesAny(EXPLAINER_REQUESTED, text)) {
    return { kind: VISUAL_KINDS.EXPLAINER, source: 'matched', topicText };
  }

  const isTerse = wordCount <= TERSE_MAX_WORDS && CONCEPT_MAP_TERSE.test(text);

  if (isTerse || matchesAny(CONCEPT_MAP_REQUESTED, text)) {
    return { kind: VISUAL_KINDS.CONCEPT_MAP, source: 'matched', topicText };
  }

  return { kind: null, source: null, topicText };
}

module.exports = {
  routeVisualIntent,
  extractTopicText,
  normalizeIntentText,
};
