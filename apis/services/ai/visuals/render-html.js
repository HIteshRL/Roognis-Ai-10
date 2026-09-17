/**
 * The only place an explainer document is assembled.
 *
 * The model supplies three strings — markup, styles, script. It never writes
 * the doctype, the <head>, the CSP, or the theme block, and it never chooses
 * where its own code lands. That split is what keeps the controls out of the
 * model's reach: a document that authored its own CSP could weaken it.
 *
 * Rendered on read, like the SVG tier, so a hardening change here applies
 * retroactively to every artifact already stored rather than only to new ones.
 *
 * ── The controls, and which one is actually load-bearing ───────────────────
 * The CSP written here is the second of the two real controls (the first,
 * `sandbox="allow-scripts"` with no `allow-same-origin`, is set by the client
 * on the iframe — see kinds.js). `default-src 'none'` means no image, font,
 * stylesheet, script, frame, or connection of any kind can be fetched, so an
 * explainer has no route off the page even if the scan missed something.
 *
 * `script-src 'unsafe-inline'` looks alarming and is the point: the whole
 * document is inline by construction, and there is nothing to protect it from —
 * the document has no origin, no cookies, no storage and no network. The XSS
 * that CSP normally prevents has nothing left to steal.
 */
const { scanExplainerSource } = require('./explainer-scan');
const { themeStyleBlock, normalizeTheme } = require('./theme-tokens');

/**
 * No `frame-ancestors` — it is ignored in a <meta> CSP, and the sandbox
 * attribute is what governs embedding anyway. `img-src data:` allows an inline
 * SVG data URI, which is the one way an explainer can carry a picture without
 * the network.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Escape a string for HTML text or a double-quoted attribute.
 *
 * Only used for values *we* interpolate — the title and the summary. The
 * model's own html field is emitted as markup by definition, which is what the
 * scan and the sandbox exist to make survivable.
 */
function escapeHtmlText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutralise any `</script` sequence inside the model's script body.
 *
 * An inline <script> ends at the first `</script`, wherever it appears —
 * including inside a string literal. Without this, `js` containing
 * `"</script><img onerror=…>"` would close our tag early and the rest would be
 * parsed as markup, outside everything the scan looked at. The `<\/` form is
 * identical to `</` to a JavaScript parser and invisible to the HTML tokenizer,
 * so the code still runs exactly as written.
 */
function neutralizeScriptClose(source) {
  return String(source).replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Assemble one explainer into a complete, self-contained HTML document.
 *
 * `theme` is 'light' | 'dark' | '' — the parent stamps the student's current
 * choice, and an empty value leaves the document to `prefers-color-scheme`.
 *
 * The scan runs again here. It already ran at generation time, so this is pure
 * defence in depth: it means a spec written by an older build, or one that
 * somehow reached the table another way, still cannot be served.
 */
function renderExplainerHtml(spec, { theme = '' } = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('renderExplainerHtml: a spec object is required.');
  }

  const html = String(spec.html || '');
  const css = String(spec.css || '');
  const js = String(spec.js || '');

  scanExplainerSource({ html, css, js });

  const resolvedTheme = normalizeTheme(theme);
  const themeAttr = resolvedTheme ? ` data-theme="${resolvedTheme}"` : '';

  return [
    '<!doctype html>',
    `<html lang="en"${themeAttr}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtmlText(spec.title)}</title>`,
    '<style>',
    themeStyleBlock(),
    // The frame paints its own surface rather than being transparent. A
    // transparent body sounds tidier — it would blend into the host card — but
    // `color-scheme` makes the UA paint its own canvas behind it, which renders
    // as a black rectangle in dark mode instead of the card colour. Observed,
    // not theorised. Painting --surface explicitly is what makes it match.
    [
      '* { box-sizing: border-box; }',
      'html, body { margin: 0; padding: 0; }',
      'html { background: var(--surface); }',
      'body {',
      '  font-family: var(--font-body);',
      '  color: var(--ink);',
      '  background: var(--surface);',
      '  font-size: 14px;',
      '  line-height: 1.5;',
      '  padding: 12px;',
      '}',
      // A model that writes `<svg width="100" height="100">` gets a 100px
      // picture on a 320px phone with its own labels clipped — seen on the
      // first real generation. Scaling any un-sized svg to the column is a
      // cheaper fix than hoping the prompt lands every time.
      'svg { max-width: 100%; height: auto; }',
      'img, canvas { max-width: 100%; }',
      'button, input, select { font: inherit; color: inherit; }',
      // iOS Safari paints button text in system blue unless colour is explicit
      // — the same trap as DESIGN.md §9 invariant 10, which applies here too
      // because this document does not inherit the fix from the parent sheet.
      'button { color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);',
      '  border-radius: 8px; min-height: 40px; padding: 0 14px; cursor: pointer; }',
      'button:hover { border-color: var(--line-strong); }',
    ].join('\n'),
    css,
    '</style>',
    '</head>',
    '<body>',
    html,
    '<script>',
    // Wrapped so a `const` in one explainer cannot collide with anything, and
    // so a throw is contained rather than leaving a half-initialised widget.
    '(function(){',
    neutralizeScriptClose(js),
    '})();',
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** The plain-text equivalent a client shows beside the frame. */
function explainerAltText(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const title = typeof spec.title === 'string' ? spec.title.trim() : '';
  const summary = typeof spec.summary === 'string' ? spec.summary.trim() : '';
  if (!title) return summary;
  if (!summary) return title;
  return `${title}. ${summary}`;
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  escapeHtmlText,
  neutralizeScriptClose,
  renderExplainerHtml,
  explainerAltText,
};
