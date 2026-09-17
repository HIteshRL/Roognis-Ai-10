/**
 * The visual kinds this service can actually produce.
 *
 * This list contains only kinds something can render today. It grows one entry
 * at a time as each renderer lands, rather than declaring the full eventual
 * vocabulary up front — a kind the router can return but nothing can draw is a
 * placeholder, and placeholders are forbidden (MASTERCONTEXT §12).
 *
 * Planned additions, each with its own renderer: flowchart, plot, labelled
 * (template-backed).
 */
const VISUAL_KINDS = {
  /**
   * Raster illustration. Not produced here — this kind exists so the router can
   * name the destination, and the route hands it to the pre-existing
   * POST /api/ai/image diffusion path (Gemini or ComfyUI).
   *
   * Diffusion is the right tool for "what did a Mughal-era coin look like" and
   * the wrong tool for anything with labels: it cannot render legible text.
   */
  PICTURE: 'picture',

  /** Node/edge map of how the ideas in a chapter relate. Rendered as inert SVG. */
  CONCEPT_MAP: 'concept_map',

  /**
   * A small self-contained interactive explainer: one idea from the chapter the
   * student can move a control on and watch respond.
   *
   * This is the one kind where the model authors markup and code, which inverts
   * the rule the SVG tier is built on. That inversion is deliberate and scoped:
   * an explainer is a thing you *operate*, and a JSON spec that could describe
   * every such thing would be a programming language with extra steps. What
   * makes it safe is not the model behaving — see EXECUTABLE_KINDS.
   *
   * It renders. It must never measure: no scoring, no grading, no persistence,
   * no reporting. Those are decisions, and decisions are not the LLM's
   * (MASTERCONTEXT §7.1-2). The scan enforces the mechanics of that; the prompt
   * states the intent.
   */
  EXPLAINER: 'explainer',
};

const ALL_VISUAL_KINDS = Object.values(VISUAL_KINDS);

/** Kinds rendered by this service as structured, non-executable SVG. */
const INERT_KINDS = [VISUAL_KINDS.CONCEPT_MAP];

/**
 * Kinds that ship executable code to the browser.
 *
 * The distinction is load-bearing: executable output must clear a static scan
 * and render inside an opaque-origin sandbox, and it fails closed.
 *
 * The three layers are not equal, and it matters which one is doing the work:
 *
 *   1. `sandbox="allow-scripts"` WITHOUT `allow-same-origin` — the document
 *      gets an opaque origin, so it cannot reach the parent DOM, the `jwt`
 *      cookie, localStorage, or any same-origin API. Granting both attributes
 *      together lets a frame remove its own sandbox; they must never both
 *      appear.
 *   2. A CSP of `default-src 'none'` inside the document — nothing can be
 *      fetched, so nothing can be exfiltrated even if step 3 is defeated.
 *   3. `explainer-scan.js` — a deny-list over the model's own source.
 *
 * 1 and 2 are the boundary. 3 is quality control: a regex pass over JavaScript
 * is not a sound security control on its own, because obfuscation beats pattern
 * matching, and pretending otherwise is how a scan becomes load-bearing by
 * accident. It earns its place by failing closed and by catching the honest
 * mistakes, not by being the thing that stops an attacker.
 */
const EXECUTABLE_KINDS = [VISUAL_KINDS.EXPLAINER];

const isVisualKind = (kind) => ALL_VISUAL_KINDS.includes(kind);
const isInert = (kind) => INERT_KINDS.includes(kind);
const isExecutable = (kind) => EXECUTABLE_KINDS.includes(kind);

/** True when this service generates and stores an artifact for the kind. */
const isGeneratedHere = (kind) => isInert(kind) || isExecutable(kind);

module.exports = {
  VISUAL_KINDS,
  ALL_VISUAL_KINDS,
  INERT_KINDS,
  EXECUTABLE_KINDS,
  isVisualKind,
  isInert,
  isExecutable,
  isGeneratedHere,
};
