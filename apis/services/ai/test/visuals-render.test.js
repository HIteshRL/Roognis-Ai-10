const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { escapeSvgText, svgId, renderConceptMapSvg, conceptMapAltText } = require('../visuals/render-svg');
const { layoutGraph } = require('../visuals/graph-layout');

const ARTIFACT_ID = '8f14e45f-ea8d-4b1e-9a7c-000000000001';

function render(spec, artifactId = ARTIFACT_ID) {
  return renderConceptMapSvg(layoutGraph(spec), {
    artifactId,
    title: spec.title,
    altText: conceptMapAltText(spec),
  });
}

const spec = {
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
};

describe('escapeSvgText', () => {
  it('escapes all five XML predefined entities', () => {
    assert.equal(escapeSvgText(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
  });

  it('escapes ampersands before the entities it introduces', () => {
    // Getting this order wrong yields &amp;lt; — a classic double-escape bug.
    assert.equal(escapeSvgText('&lt;'), '&amp;lt;');
  });

  it('renders null and undefined as empty rather than as text', () => {
    assert.equal(escapeSvgText(null), '');
    assert.equal(escapeSvgText(undefined), '');
  });
});

describe('svgId', () => {
  it('namespaces an id to its artifact', () => {
    assert.equal(svgId(ARTIFACT_ID, 'clip'), 'rv-8f14e45fea8d4b1e9a7c000000000001-clip');
  });

  it('strips characters that would make an invalid NCName', () => {
    assert.ok(/^rv-[A-Za-z0-9]*-[A-Za-z0-9-]+$/.test(svgId('a b"c<', 'x y')));
  });

  it('never returns a bare id when the artifact id is missing', () => {
    assert.ok(svgId(null, 'clip').startsWith('rv-'));
  });
});

describe('concept map SVG rendering', () => {
  it('emits a well-formed, labelled root element', () => {
    const svg = render(spec);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(/viewBox="0 0 \d+ \d+"/.test(svg));
    assert.ok(svg.includes('role="img"'));
    assert.ok(svg.includes('<title'));
    assert.ok(svg.includes('<desc'), 'a <desc> is the accessible equivalent for a many-node graph');
    assert.ok(svg.includes('aria-labelledby='));
  });

  it('escapes a script payload smuggled through a node label', () => {
    // The renderer's escaping is the ONLY defence here: the client assigns this
    // string with innerHTML and does no escaping of its own.
    const hostile = {
      ...spec,
      nodes: [
        { id: 'photo', label: '</svg><script>alert(1)</script>' },
        { id: 'light', label: 'Light energy' },
        { id: 'glucose', label: 'Glucose' },
      ],
    };
    const svg = render(hostile);
    assert.ok(!/<script/i.test(svg), 'no live script tag may survive');
    assert.ok(svg.includes('&lt;script&gt;') || svg.includes('&lt;/svg&gt;'), 'payload must appear escaped');
  });

  it('escapes a payload smuggled through the title and an edge label', () => {
    const hostile = {
      ...spec,
      title: '"><script>x</script>',
      edges: [
        { from: 'photo', to: 'light', label: '<img onerror=x>' },
        { from: 'photo', to: 'glucose', label: '' },
      ],
    };
    const svg = render(hostile);
    assert.ok(!/<script/i.test(svg));
    assert.ok(!/<img/i.test(svg));
  });

  it('contains no literal colour', () => {
    // DESIGN.md §2 and §9 invariant 5: a hex literal survives a theme swap and
    // freezes one theme's palette into stored output. Structural colour must
    // come from CSS classes bound to Chroma Bloom tokens.
    const svg = render(spec);
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(svg), false, 'found a hex colour literal');
    assert.equal(/\brgba?\(/i.test(svg), false, 'found an rgb() colour literal');
    assert.equal(/\bfill="(?!none|currentColor)[a-z]+"/i.test(svg), false, 'found a named colour');
  });

  it('namespaces every id so two visuals on one page cannot collide', () => {
    const svg = render(spec);
    const ids = svg.match(/id="([^"]+)"/g) || [];
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => id.includes('rv-8f14e45f')), `unscoped id found: ${ids.join(' ')}`);

    // A second artifact must share no ids with the first.
    const other = render(spec, '00000000-0000-4000-8000-000000000002');
    const otherIds = new Set((other.match(/id="([^"]+)"/g) || []));
    assert.ok(ids.every(id => !otherIds.has(id)), 'two artifacts produced a colliding id');
  });

  it('references only its own marker', () => {
    const svg = render(spec);
    const markerId = svg.match(/<marker id="([^"]+)"/)[1];
    for (const reference of svg.match(/url\(#([^)]+)\)/g) || []) {
      assert.equal(reference, `url(#${markerId})`);
    }
  });

  it('flips the arrowhead on a cycle-reversed edge', () => {
    const cyclic = {
      ...spec,
      edges: [
        { from: 'photo', to: 'light', label: '' },
        { from: 'light', to: 'glucose', label: '' },
        { from: 'glucose', to: 'photo', label: 'fuels' },
      ],
    };
    const svg = render(cyclic);
    assert.ok(svg.includes('marker-start='), 'a reversed edge must point back the way the model meant');
  });

  it('makes no external reference and embeds no script or event handler', () => {
    const svg = render(spec);
    assert.equal(/https?:\/\/(?!www\.w3\.org)/i.test(svg), false, 'no external host');
    assert.equal(/\son[a-z]+=/i.test(svg), false, 'no inline event handler');
    assert.equal(/<(script|foreignObject|use|image|animate|set)\b/i.test(svg), false);
  });

  it('renders byte-identically for the same spec and artifact', () => {
    assert.equal(render(spec), render(spec));
  });

  it('describes the whole map in the text alternative', () => {
    const alt = conceptMapAltText(spec);
    assert.ok(alt.includes('Photosynthesis'));
    assert.ok(alt.includes('Light energy'));
    assert.ok(alt.includes('needs'), 'relationships must be spelled out, not just node names');
  });
});
