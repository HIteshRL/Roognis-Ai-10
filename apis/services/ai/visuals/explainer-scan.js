/**
 * Static scan over model-authored explainer source.
 *
 * ── What this is, and what it is not ───────────────────────────────────────
 * This is NOT the security boundary. A deny-list of regexes over JavaScript can
 * be defeated by anyone who wants to: `window['fe'+'tch']` is not hard to
 * write. The boundary is the opaque-origin sandbox and a CSP of
 * `default-src 'none'` (see kinds.js) — those hold whether or not this file
 * catches anything, and they are what makes it acceptable to run model-written
 * code at all.
 *
 * What this file is for:
 *   - It fails closed, so a generation that reaches for a forbidden capability
 *     is thrown away rather than shipped. HANDOFF.md's requirement for the
 *     executable tier.
 *   - It runs inside the validator, so its message becomes the model's
 *     correction turn (structured-llm.js). Most hits are a model doing
 *     something reasonable-looking — `localStorage` to remember a slider — and
 *     it simply rewrites without it. That is the common case, not an attack.
 *   - It keeps the explainer a *renderer*. `fetch` and storage are how a
 *     visual would quietly start measuring, and measurement is not the LLM's
 *     (MASTERCONTEXT §7.1-2).
 *
 * Every message names the field, the construct and what to do instead, because
 * a message that just says "forbidden pattern" produces a second attempt with
 * the same defect.
 */

class ExplainerScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExplainerScanError';
  }
}

/**
 * Rules applied to the `js` field.
 *
 * `remedy` is the half that matters for the retry: the model needs to know what
 * to write instead, not merely that it was wrong.
 */
const SCRIPT_RULES = [
  {
    pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bnavigator\s*\.\s*connection\b/i,
    what: 'a network call',
    remedy: 'An explainer runs with no network access at all. Compute everything from values already in the code.',
  },
  {
    pattern: /\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(|\bimportScripts\b|\bdocument\s*\.\s*write\b/i,
    what: 'dynamically evaluated code',
    remedy: 'Write the logic out directly instead of building it from strings.',
  },
  {
    pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\s*\.\s*cookie\b|\bcaches\b/i,
    what: 'persistent storage',
    remedy:
      'An explainer keeps no state between visits — that is deliberate, because it records nothing about the ' +
      'student. Hold state in ordinary variables.',
  },
  {
    pattern: /\bwindow\s*\.\s*(?:parent|top|opener)\b|\b(?:parent|top)\s*\.\s*(?:document|location|postMessage)\b|\bpostMessage\s*\(/i,
    what: 'access to the surrounding page',
    remedy: 'The explainer is isolated by design. Use only elements from your own html field.',
  },
  {
    pattern: /\bnavigator\s*\.\s*(?:geolocation|mediaDevices|clipboard|credentials|serviceWorker)\b|\bNotification\b|\bWorker\s*\(/i,
    what: 'a device or browser capability',
    remedy: 'Use only ordinary DOM elements, arithmetic and CSS.',
  },
  {
    pattern: /\blocation\s*\.\s*(?:href|assign|replace)\b|\bwindow\s*\.\s*open\s*\(/i,
    what: 'navigation',
    remedy: 'An explainer never navigates. Update the elements on the page instead.',
  },
];

/** Rules applied to `html`. Markup cannot carry behaviour — that is what `js` is for. */
const MARKUP_RULES = [
  {
    pattern: /<\s*(?:script|iframe|object|embed|form|base|meta|link|portal|frame|frameset)\b/i,
    what: 'a forbidden element',
    remedy:
      'Use only ordinary content elements (div, span, p, button, input, label, svg, canvas, table). ' +
      'Scripts belong in the js field and styles in the css field.',
  },
  {
    pattern: /\son[a-z]+\s*=/i,
    what: 'an inline event handler attribute',
    remedy: 'Give the element an id and attach the listener with addEventListener in the js field.',
  },
  {
    pattern: /\b(?:href|src|action|data|poster|formaction|xlink:href)\s*=\s*["']?\s*javascript:/i,
    what: 'a javascript: URL',
    remedy: 'Attach behaviour with addEventListener in the js field.',
  },
];

/** Rules applied to `css`. */
const STYLE_RULES = [
  {
    pattern: /@import\b|\bexpression\s*\(|\bbehavior\s*:/i,
    what: 'an imported or executable stylesheet construct',
    remedy: 'Write the rules out directly.',
  },
];

/**
 * Any external reference, in any field.
 *
 * The CSP already blocks the request, so this is not what stops a load — it
 * stops the model shipping an explainer whose picture is a silent broken image
 * in every student's browser. A visual that depends on the network is broken by
 * construction here, and better rejected than rendered half-empty.
 */
const EXTERNAL_REFERENCE = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;

function scanField(source, field, rules) {
  for (const rule of rules) {
    const match = rule.pattern.exec(source);
    if (match) {
      throw new ExplainerScanError(
        `${field} contains ${rule.what} ("${match[0].trim().slice(0, 40)}"), which an explainer may not use. ${rule.remedy}`
      );
    }
  }

  const external = EXTERNAL_REFERENCE.exec(source);
  if (external) {
    throw new ExplainerScanError(
      `${field} refers to an external address ("${external[0].slice(0, 60)}"). An explainer cannot load anything ` +
      'from the network — draw shapes with CSS or inline SVG instead of linking to an image or a library.'
    );
  }
}

/**
 * Scan one explainer spec. Throws ExplainerScanError on the first violation.
 *
 * Called twice by design: once inside the validator at generation time, and
 * again in render-html.js on every read. The second call is what makes the
 * rule retroactive — a spec stored before a rule existed, or by a version with
 * a bug, cannot be served just because it is already in the database.
 */
function scanExplainerSource({ html = '', css = '', js = '' } = {}) {
  scanField(String(html), 'html', MARKUP_RULES);
  scanField(String(css), 'css', STYLE_RULES);
  scanField(String(js), 'js', SCRIPT_RULES);
  return true;
}

module.exports = {
  ExplainerScanError,
  SCRIPT_RULES,
  MARKUP_RULES,
  STYLE_RULES,
  EXTERNAL_REFERENCE,
  scanExplainerSource,
};
