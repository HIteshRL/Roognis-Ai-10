const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateConceptMapSpec,
  collectSpecText,
  CONCEPT_MAP_LIMITS,
  SpecValidationError,
} = require('../visuals/spec-validate');

const KNOWN = ['chunk-a', 'chunk-b', 'chunk-c'];

function baseSpec(overrides = {}) {
  return {
    title: 'Photosynthesis',
    nodes: [
      { id: 'photo', label: 'Photosynthesis' },
      { id: 'light', label: 'Light energy' },
      { id: 'glucose', label: 'Glucose' },
    ],
    edges: [
      { from: 'photo', to: 'light', label: 'needs' },
      { from: 'photo', to: 'glucose', label: 'makes' },
    ],
    citations: ['chunk-a'],
    ...overrides,
  };
}

/** Assert it throws, and that the message actually names the problem. */
function rejects(spec, ...expectedFragments) {
  let message = null;
  try {
    validateConceptMapSpec(spec, { knownChunkIds: KNOWN });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message, 'expected the spec to be rejected');
  for (const fragment of expectedFragments) {
    assert.ok(
      message.toLowerCase().includes(fragment.toLowerCase()),
      `message should mention "${fragment}" — it becomes the model's correction turn. Got: ${message}`
    );
  }
  return message;
}

describe('concept map spec validation', () => {
  it('accepts and normalizes a good spec', () => {
    const spec = validateConceptMapSpec(baseSpec({ title: '  Photosynthesis  ' }), { knownChunkIds: KNOWN });
    assert.equal(spec.title, 'Photosynthesis');
    assert.equal(spec.nodes.length, 3);
    assert.equal(spec.edges.length, 2);
    assert.deepEqual(spec.citations, ['chunk-a']);
  });

  it('rejects a non-object payload', () => {
    rejects(null, 'json object');
    rejects([], 'json object');
  });

  it('rejects a missing or overlong title', () => {
    rejects(baseSpec({ title: '' }), 'title', 'empty');
    rejects(baseSpec({ title: 'x'.repeat(CONCEPT_MAP_LIMITS.titleMaxChars + 1) }), 'title', 'at most');
  });

  it('rejects too few and too many nodes, naming the bound and the count', () => {
    const tooFew = rejects(baseSpec({
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ from: 'a', to: 'b', label: '' }],
    }), 'nodes', '3 to 20', 'got 2');
    assert.ok(/got 2/.test(tooFew));

    const many = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    rejects(baseSpec({
      nodes: many,
      edges: many.slice(1).map(node => ({ from: 'n0', to: node.id, label: '' })),
    }), 'nodes', '3 to 20', 'got 21');
  });

  it('rejects a duplicate node id', () => {
    rejects(baseSpec({
      nodes: [
        { id: 'photo', label: 'A' },
        { id: 'photo', label: 'B' },
        { id: 'other', label: 'C' },
      ],
    }), 'duplicate');
  });

  it('rejects a node id that is not a slug', () => {
    rejects(baseSpec({
      nodes: [
        { id: 'Photo Synthesis', label: 'A' },
        { id: 'light', label: 'B' },
        { id: 'glucose', label: 'C' },
      ],
    }), 'slug');
  });

  it('rejects an overlong node label', () => {
    rejects(baseSpec({
      nodes: [
        { id: 'photo', label: 'x'.repeat(CONCEPT_MAP_LIMITS.nodeLabelMaxChars + 1) },
        { id: 'light', label: 'B' },
        { id: 'glucose', label: 'C' },
      ],
    }), 'label', 'at most');
  });

  it('rejects an edge pointing at an undeclared node', () => {
    rejects(baseSpec({
      edges: [
        { from: 'photo', to: 'light', label: '' },
        { from: 'photo', to: 'glucose', label: '' },
        { from: 'photo', to: 'ghost', label: '' },
      ],
    }), 'ghost', 'not one of the node ids');
  });

  it('rejects a self-loop', () => {
    rejects(baseSpec({
      edges: [
        { from: 'photo', to: 'photo', label: '' },
        { from: 'photo', to: 'light', label: '' },
        { from: 'photo', to: 'glucose', label: '' },
      ],
    }), 'itself');
  });

  it('rejects a duplicated edge pair', () => {
    rejects(baseSpec({
      edges: [
        { from: 'photo', to: 'light', label: '' },
        { from: 'photo', to: 'light', label: 'again' },
        { from: 'photo', to: 'glucose', label: '' },
      ],
    }), 'duplicates');
  });

  it('rejects an orphan node', () => {
    // A node no edge touches renders as a floating box with no explanation of
    // why it is on the page.
    rejects(baseSpec({
      nodes: [
        { id: 'photo', label: 'Photosynthesis' },
        { id: 'light', label: 'Light' },
        { id: 'lonely', label: 'Unconnected' },
      ],
      edges: [{ from: 'photo', to: 'light', label: '' }],
    }), 'lonely', 'not connected');
  });

  it('accepts an empty edge label but rejects an overlong one', () => {
    const spec = validateConceptMapSpec(baseSpec({
      edges: [
        { from: 'photo', to: 'light', label: '' },
        { from: 'photo', to: 'glucose', label: '' },
      ],
    }), { knownChunkIds: KNOWN });
    assert.equal(spec.edges[0].label, '');

    rejects(baseSpec({
      edges: [
        { from: 'photo', to: 'light', label: 'x'.repeat(CONCEPT_MAP_LIMITS.edgeLabelMaxChars + 1) },
        { from: 'photo', to: 'glucose', label: '' },
      ],
    }), 'label', 'at most');
  });

  it('rejects a hallucinated citation rather than repairing it', () => {
    // Unlike the quiz path, which repairs: there is no validated answer key
    // here worth salvaging, so a wrong citation regenerates instead.
    rejects(baseSpec({ citations: ['chunk-a', 'chunk-invented'] }), 'chunk-invented', 'chunkid');
  });

  it('rejects too few or too many citations', () => {
    rejects(baseSpec({ citations: [] }), 'citations', '1 to 6');
    rejects(
      baseSpec({ citations: Array.from({ length: 7 }, () => 'chunk-a') }),
      'citations', '1 to 6'
    );
  });

  it('de-duplicates repeated citations', () => {
    const spec = validateConceptMapSpec(
      baseSpec({ citations: ['chunk-a', 'chunk-a', 'chunk-b'] }),
      { knownChunkIds: KNOWN }
    );
    assert.deepEqual(spec.citations, ['chunk-a', 'chunk-b']);
  });

  it('rejects every citation when no chunk ids are supplied', () => {
    // An empty knownChunkIds means no grounding chunks were given to the
    // model, so any citation it names is unsupported by definition — it must
    // be rejected, not silently accepted.
    assert.throws(
      () => validateConceptMapSpec(baseSpec({ citations: ['anything'] }), {}),
      SpecValidationError
    );
  });

  it('collects every human-visible string for the safety pass', () => {
    const text = collectSpecText(baseSpec());
    assert.ok(text.includes('Photosynthesis'));
    assert.ok(text.includes('Light energy'));
    assert.ok(text.includes('needs'));
  });
});
