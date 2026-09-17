const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  wrapLabel,
  removeCycles,
  assignLayers,
  orderLayers,
  medianOf,
  layoutGraph,
  LAYOUT,
} = require('../visuals/graph-layout');

const nodes = ids => ids.map(id => ({ id, label: id.toUpperCase() }));
const edges = pairs => pairs.map(([from, to]) => ({ from, to, label: '' }));
const layersOf = map => Object.fromEntries([...map.entries()]);

describe('graph layering', () => {
  it('lays a chain out one node per layer', () => {
    const layer = assignLayers(nodes(['a', 'b', 'c']), edges([['a', 'b'], ['b', 'c']]));
    assert.deepEqual(layersOf(layer), { a: 0, b: 1, c: 2 });
  });

  it('uses the longest path, not the shortest', () => {
    // a->c directly and a->b->c. c must sit below b, or the edge a->c would
    // have to travel upward.
    const layer = assignLayers(nodes(['a', 'b', 'c']), edges([['a', 'c'], ['a', 'b'], ['b', 'c']]));
    assert.deepEqual(layersOf(layer), { a: 0, b: 1, c: 2 });
  });

  it('puts every root of a forest on layer 0', () => {
    const layer = assignLayers(nodes(['a', 'b', 'c', 'd']), edges([['a', 'b'], ['c', 'd']]));
    assert.deepEqual(layersOf(layer), { a: 0, b: 1, c: 0, d: 1 });
  });

  it('throws rather than laying out a graph that still has a cycle', () => {
    assert.throws(
      () => assignLayers(nodes(['a', 'b']), edges([['a', 'b'], ['b', 'a']])),
      /cycle/i
    );
  });
});

describe('cycle removal', () => {
  it('reverses exactly one edge of a 3-cycle, deterministically', () => {
    const input = edges([['a', 'b'], ['b', 'c'], ['c', 'a']]);
    const first = removeCycles(nodes(['a', 'b', 'c']), input);

    assert.deepEqual(first.reversedIndexes, [2]);
    const reversed = first.edges.filter(edge => edge.reversed);
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].from, 'a');
    assert.equal(reversed[0].to, 'c');

    // Which edge gets reversed must not vary between runs, or the cache would
    // hand back a different picture for the same spec.
    const second = removeCycles(nodes(['a', 'b', 'c']), edges([['a', 'b'], ['b', 'c'], ['c', 'a']]));
    assert.deepEqual(second.reversedIndexes, first.reversedIndexes);
  });

  it('leaves an acyclic graph untouched', () => {
    const result = removeCycles(nodes(['a', 'b', 'c']), edges([['a', 'b'], ['b', 'c']]));
    assert.deepEqual(result.reversedIndexes, []);
    assert.ok(result.edges.every(edge => edge.reversed === false));
  });

  it('breaks a self-referential two-cycle', () => {
    const result = removeCycles(nodes(['a', 'b']), edges([['a', 'b'], ['b', 'a']]));
    assert.equal(result.reversedIndexes.length, 1);
    // The result must now be layerable.
    assert.doesNotThrow(() => assignLayers(nodes(['a', 'b']), result.edges));
  });

  it('produces a layerable graph from a dense cyclic mess', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pairs = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'b'], ['e', 'a'], ['d', 'e']];
    const result = removeCycles(nodes(ids), edges(pairs));
    assert.doesNotThrow(() => assignLayers(nodes(ids), result.edges));
  });
});

describe('median ordering', () => {
  it('computes an integer-stable median', () => {
    assert.equal(medianOf([0, 2, 4], -1), 2);
    assert.equal(medianOf([1, 3], -1), 2);
    assert.equal(medianOf([], 7), 7, 'a node with no neighbour keeps its position');
  });

  it('reorders a layer to follow its predecessors', () => {
    // Layer 1 is declared in the order x,y but their parents are b,a — so after
    // ordering, y (child of a, position 0) must come before x (child of b).
    const graphNodes = nodes(['a', 'b', 'x', 'y']);
    const graphEdges = edges([['b', 'x'], ['a', 'y']]);
    const layer = assignLayers(graphNodes, graphEdges);
    const ordered = orderLayers(graphNodes, graphEdges, layer);

    assert.deepEqual(ordered[0], ['a', 'b']);
    assert.deepEqual(ordered[1], ['y', 'x']);
  });
});

describe('label wrapping', () => {
  it('leaves a short label on one line', () => {
    assert.deepEqual(wrapLabel('Photosynthesis'), ['Photosynthesis']);
  });

  it('wraps and caps at the line limit with an ellipsis', () => {
    const lines = wrapLabel('the process by which green plants convert light into chemical energy');
    assert.ok(lines.length <= LAYOUT.maxLines);
    assert.ok(lines[lines.length - 1].endsWith('…'), 'truncation must be visible');
    assert.ok(lines.every(line => line.length <= LAYOUT.charsPerLine));
  });

  it('hard-splits a word longer than the line budget', () => {
    const lines = wrapLabel('Pneumonoultramicroscopicsilicovolcanoconiosis');
    assert.ok(lines.length > 1);
    assert.ok(lines.every(line => line.length <= LAYOUT.charsPerLine));
  });

  it('returns nothing for an empty label', () => {
    assert.deepEqual(wrapLabel(''), []);
    assert.deepEqual(wrapLabel(null), []);
  });
});

describe('full layout', () => {
  const spec = {
    title: 'Photosynthesis',
    nodes: nodes(['photo', 'light', 'water', 'glucose', 'oxygen']),
    edges: edges([
      ['photo', 'light'], ['photo', 'water'],
      ['light', 'glucose'], ['water', 'glucose'], ['glucose', 'oxygen'],
    ]),
  };

  it('never overlaps two node boxes', () => {
    const layout = layoutGraph(spec);
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlapping = a.x < b.x + b.width && b.x < a.x + a.width
          && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.equal(overlapping, false, `${a.id} overlaps ${b.id}`);
      }
    }
  });

  it('contains every node inside the viewBox', () => {
    const layout = layoutGraph(spec);
    for (const node of layout.nodes) {
      assert.ok(node.x >= 0 && node.y >= 0, `${node.id} is outside the top-left`);
      assert.ok(node.x + node.width <= layout.width, `${node.id} overflows the width`);
      assert.ok(node.y + node.height <= layout.height, `${node.id} overflows the height`);
    }
  });

  it('routes every edge from its source boundary to its target boundary', () => {
    const layout = layoutGraph(spec);
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    for (const edge of layout.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const [, startX, startY] = edge.path.match(/^M ([\d.]+) ([\d.]+)/).map(Number);
      assert.ok(Math.abs(startX - from.centreX) < 0.5, 'edge must leave the source centre');
      assert.ok(Math.abs(startY - (from.y + from.height)) < 0.5, 'edge must leave the source bottom');
      assert.ok(edge.path.endsWith(`V ${to.y.toFixed(1)}`), 'edge must arrive at the target top');
    }
  });

  it('keeps every edge channel inside the gap between its layers', () => {
    const layout = layoutGraph(spec);
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    for (const edge of layout.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const channelY = Number(edge.path.match(/V ([\d.]+) H/)[1]);
      assert.ok(channelY > from.y + from.height, 'channel must be below the source');
      assert.ok(channelY < to.y, 'channel must be above the target');
    }
  });

  it('renders the same spec to identical geometry every time', () => {
    // The cache assumes this: a stored spec must re-render to the same picture.
    assert.deepEqual(layoutGraph(spec), layoutGraph(spec));
  });

  it('lays out a cyclic spec without throwing', () => {
    const cyclic = {
      title: 'Cycle',
      nodes: nodes(['a', 'b', 'c']),
      edges: edges([['a', 'b'], ['b', 'c'], ['c', 'a']]),
    };
    const layout = layoutGraph(cyclic);
    assert.equal(layout.nodes.length, 3);
    assert.equal(layout.edges.filter(edge => edge.reversed).length, 1);
  });
});
