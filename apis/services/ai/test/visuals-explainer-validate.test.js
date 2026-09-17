/**
 * Bounds checking for explainer specs.
 *
 * Every rejection asserts on the message text, because structured-llm.js hands
 * it back as the model's correction turn — "invalid height" produces a second
 * attempt with the same defect, "height must be between 240 and 720 pixels, got
 * 4000" does not.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateExplainerSpec,
  collectExplainerText,
  EXPLAINER_LIMITS,
  ExplainerValidationError,
} = require('../visuals/explainer-validate');

const L = EXPLAINER_LIMITS;

const baseSpec = (overrides = {}) => ({
  title: 'Pressure and area',
  summary: 'Drag the slider to change the area a fixed force is spread over, and watch the pressure change as a result.',
  html: '<div id="stage"><input id="area" type="range"><p id="out">20 Pa</p></div>',
  css: '#stage { color: var(--ink); }',
  js: 'document.getElementById("area").addEventListener("input", () => {});',
  height: 320,
  citations: ['chunk-1'],
  ...overrides,
});

function rejects(spec, ...expectedFragments) {
  let error = null;
  try {
    validateExplainerSpec(spec, { knownChunkIds: ['chunk-1', 'chunk-2'] });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected validation to reject this spec');
  for (const fragment of expectedFragments) {
    assert.ok(
      error.message.toLowerCase().includes(fragment.toLowerCase()),
      `message should mention "${fragment}" — it becomes the model's correction turn. Got: ${error.message}`
    );
  }
}

describe('explainer spec validation', () => {
  it('accepts and normalizes a good spec', () => {
    const spec = validateExplainerSpec(baseSpec({ title: '  Pressure and area  ' }), {
      knownChunkIds: ['chunk-1'],
    });
    assert.equal(spec.title, 'Pressure and area');
    assert.equal(spec.height, 320);
    assert.deepEqual(spec.citations, ['chunk-1']);
  });

  it('rejects a non-object payload', () => {
    rejects(null, 'json object');
    rejects([], 'json object');
  });

  it('rejects a missing or overlong title', () => {
    rejects(baseSpec({ title: '' }), 'title', 'empty');
    rejects(baseSpec({ title: 'x'.repeat(L.titleMaxChars + 1) }), 'title', String(L.titleMaxChars), 'got 81');
  });

  // The summary is the text alternative a student reads instead of operating
  // the widget, so a one-word summary is a real failure, not a style nit.
  it('rejects a summary too short to be an alternative', () => {
    rejects(baseSpec({ summary: 'It shows pressure.' }), 'summary', 'at least 40', 'got 18');
  });

  it('rejects an overlong summary', () => {
    rejects(baseSpec({ summary: 'x'.repeat(L.summaryMaxChars + 1) }), 'summary', String(L.summaryMaxChars));
  });

  it('rejects empty html or js, naming the field', () => {
    rejects(baseSpec({ html: '   ' }), 'html', 'empty');
    rejects(baseSpec({ js: '' }), 'js', 'empty');
  });

  it('accepts an empty css but rejects an overlong one', () => {
    const spec = validateExplainerSpec(baseSpec({ css: '' }), { knownChunkIds: ['chunk-1'] });
    assert.equal(spec.css, '');
    rejects(baseSpec({ css: 'x'.repeat(L.cssMaxChars + 1) }), 'css', String(L.cssMaxChars));
  });

  it('rejects source past the size caps', () => {
    rejects(baseSpec({ html: '<div id="a">' + 'x'.repeat(L.htmlMaxChars) + '</div>' }), 'html', String(L.htmlMaxChars));
    rejects(baseSpec({ js: 'x'.repeat(L.jsMaxChars + 1) }), 'js', String(L.jsMaxChars));
  });

  it('rejects a non-integer or out-of-range height, naming the bound', () => {
    rejects(baseSpec({ height: 320.5 }), 'height', 'whole number');
    rejects(baseSpec({ height: '320' }), 'height', 'whole number');
    rejects(baseSpec({ height: L.minHeight - 1 }), 'height', '240', '720', 'got 239');
    rejects(baseSpec({ height: L.maxHeight + 1 }), 'height', 'got 721');
  });

  // Almost always a model that wrote its script against elements it forgot to
  // create — a defect that renders as a dead widget rather than an error.
  it('rejects markup with no id for the script to attach to', () => {
    rejects(baseSpec({ html: '<div><p>Nothing to hold on to</p></div>' }), 'html', 'no element with an id');
  });

  it('runs the static scan as part of validation', () => {
    rejects(baseSpec({ js: 'localStorage.setItem("a", 1)' }), 'js', 'persistent storage');
    rejects(baseSpec({ html: '<div id="a" onclick="x()"></div>' }), 'html', 'inline event handler');
  });

  it('rejects a hallucinated citation rather than repairing it', () => {
    rejects(baseSpec({ citations: ['chunk-9'] }), 'citations[0]', 'chunk-9', 'cite only the chunkids');
  });

  it('rejects too few or too many citations', () => {
    rejects(baseSpec({ citations: [] }), 'citations', '1 to 6', 'got 0');
    rejects(baseSpec({ citations: new Array(7).fill('chunk-1') }), 'citations', 'got 7');
  });

  it('de-duplicates repeated citations', () => {
    const spec = validateExplainerSpec(baseSpec({ citations: ['chunk-1', 'chunk-1', 'chunk-2'] }), {
      knownChunkIds: ['chunk-1', 'chunk-2'],
    });
    assert.deepEqual(spec.citations, ['chunk-1', 'chunk-2']);
  });

  it('rejects every citation when no chunk ids are supplied', () => {
    // An empty knownChunkIds means no grounding chunks were given to the
    // model, so any citation it names is unsupported by definition — it must
    // be rejected, not silently accepted.
    assert.throws(
      () => validateExplainerSpec(baseSpec({ citations: ['anything'] }), {}),
      ExplainerValidationError
    );
  });
});

describe('explainer safety text collection', () => {
  it('collects the strings a student actually reads', () => {
    const text = collectExplainerText(baseSpec({
      html: '<div id="s"><p>Force stays the same</p><button id="g">Increase area</button></div>',
    }));
    assert.ok(text.includes('Pressure and area'), 'title');
    assert.ok(text.includes('Drag the slider'), 'summary');
    assert.ok(text.includes('Force stays the same'), 'markup text');
    assert.ok(text.includes('Increase area'), 'button label');
  });

  it('collects readable attribute values', () => {
    const text = collectExplainerText(baseSpec({
      html: '<div id="s"><input id="a" placeholder="Type a weight"><img id="i" alt="A brick on sand"></div>',
    }));
    assert.ok(text.includes('Type a weight'), 'placeholder is read by the student');
    assert.ok(text.includes('A brick on sand'), 'alt text is read by the student');
  });

  /**
   * Source code is deliberately excluded.
   *
   * A prose safety rule set over JavaScript flags ordinary programming words,
   * and a check that cries wolf gets weakened until it stops working. The
   * structural risk in js is the scan's job; this pass is about what the words
   * say to a child.
   */
  it('excludes the script and style source', () => {
    const text = collectExplainerText(baseSpec({
      js: 'function killProcess() { const dead = abort(); }',
      css: '#stage { color: red; }',
    }));
    assert.equal(text.includes('killProcess'), false, 'js source must not reach the prose safety pass');
    assert.equal(text.includes('color: red'), false, 'css source must not reach the prose safety pass');
  });

  it('returns an empty string for a non-spec', () => {
    assert.equal(collectExplainerText(null), '');
    assert.equal(collectExplainerText('nope'), '');
  });
});
