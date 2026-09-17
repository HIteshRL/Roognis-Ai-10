/**
 * Deterministic layered layout for node/edge graphs.
 *
 * Layered (Sugiyama-family) layout without the expensive parts: cycle removal,
 * longest-path layering, two median-ordering sweeps, fixed coordinates,
 * orthogonal edges. No dummy nodes, no iterative crossing minimisation, no
 * convergence loop.
 *
 * That is a deliberate trade at this size. A concept map is capped at 20 nodes,
 * where legibility — not crossing-minimality — is the binding quality
 * constraint, and every step here is exactly assertable in a unit test. Full
 * Sugiyama would also mean a `dagre` dependency in a service that carries four.
 *
 * Everything is a pure function of its input: no clock, no randomness, no
 * iteration over unordered collections. The same spec must render byte-identical
 * SVG on every run, because the cache key assumes it.
 *
 * There is no text measurement available server-side, so label wrapping is a
 * greedy character-count estimate and boxes are a fixed size. This is the honest
 * constraint, not an oversight — the validator caps label length so the estimate
 * cannot overflow badly.
 */

const LAYOUT = {
  nodeWidth: 136,
  nodeHeight: 54,
  gapX: 20,
  gapY: 66,
  padding: 18,
  charsPerLine: 18,
  maxLines: 3,
  lineHeight: 13,
  orderingSweeps: 2,
};

/**
 * Greedy word wrap on a character-count estimate.
 *
 * A word longer than the line budget is hard-split rather than allowed to
 * overflow the box. The last line is ellipsised when content remains.
 */
function wrapLabel(text, { charsPerLine = LAYOUT.charsPerLine, maxLines = LAYOUT.maxLines } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of words) {
    if (lines.length >= maxLines) break;

    let remaining = word;
    // Hard-split a single word that cannot fit a line on its own.
    while (remaining.length > charsPerLine) {
      pushCurrent();
      if (lines.length >= maxLines) break;
      lines.push(remaining.slice(0, charsPerLine - 1) + '-');
      remaining = remaining.slice(charsPerLine - 1);
    }
    if (lines.length >= maxLines) break;
    if (!remaining) continue;

    const candidate = current ? `${current} ${remaining}` : remaining;
    if (candidate.length <= charsPerLine) {
      current = candidate;
    } else {
      pushCurrent();
      if (lines.length >= maxLines) break;
      current = remaining;
    }
  }
  pushCurrent();

  const kept = lines.slice(0, maxLines);
  const usedWords = kept.join(' ').replace(/-$/, '').split(/\s+/).filter(Boolean).length;
  if (usedWords < words.length && kept.length) {
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = last.length >= charsPerLine
      ? `${last.slice(0, charsPerLine - 1)}…`
      : `${last}…`;
  }
  return kept;
}

/**
 * Break cycles by reversing back edges found in a depth-first walk.
 *
 * An LLM-authored concept map will contain cycles — "photosynthesis produces
 * glucose", "glucose fuels photosynthesis" are both true — and layering requires
 * a DAG. Reversed edges are tagged so the renderer can flip the arrowhead back
 * and keep the meaning the model intended.
 *
 * DFS visits nodes and adjacency in input-array order, so which edge of a cycle
 * gets reversed is deterministic rather than incidental.
 */
function removeCycles(nodes, edges) {
  const order = nodes.map(node => node.id);
  const outgoing = new Map(order.map(id => [id, []]));
  edges.forEach((edge, index) => {
    if (outgoing.has(edge.from)) outgoing.get(edge.from).push(index);
  });

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map(order.map(id => [id, WHITE]));
  const reversed = new Set();

  // Explicit stack rather than recursion: a pathological chain should not be
  // able to blow the call stack on a request path.
  for (const root of order) {
    if (colour.get(root) !== WHITE) continue;
    const stack = [{ id: root, cursor: 0 }];
    colour.set(root, GREY);

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edgeIndexes = outgoing.get(frame.id) || [];

      if (frame.cursor >= edgeIndexes.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }

      const edgeIndex = edgeIndexes[frame.cursor];
      frame.cursor += 1;
      if (reversed.has(edgeIndex)) continue;

      const target = edges[edgeIndex].to;
      const targetColour = colour.get(target);

      if (targetColour === GREY) {
        // Back edge: reverse it rather than dropping it, so no relationship the
        // model asserted disappears from the picture.
        reversed.add(edgeIndex);
      } else if (targetColour === WHITE) {
        colour.set(target, GREY);
        stack.push({ id: target, cursor: 0 });
      }
    }
  }

  const acyclicEdges = edges.map((edge, index) => (
    reversed.has(index)
      ? { ...edge, from: edge.to, to: edge.from, reversed: true }
      : { ...edge, reversed: false }
  ));

  return { edges: acyclicEdges, reversedIndexes: [...reversed].sort((a, b) => a - b) };
}

/**
 * Longest-path layering over a DAG.
 *
 * layer(v) = 0 when v has no predecessor, else 1 + max(layer(predecessors)).
 * Kahn's algorithm supplies a processing order in which every predecessor is
 * final before its successors are read.
 */
function assignLayers(nodes, edges) {
  const order = nodes.map(node => node.id);
  const indegree = new Map(order.map(id => [id, 0]));
  const successors = new Map(order.map(id => [id, []]));

  for (const edge of edges) {
    if (!indegree.has(edge.to) || !successors.has(edge.from)) continue;
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    successors.get(edge.from).push(edge.to);
  }

  const layer = new Map(order.map(id => [id, 0]));
  const queue = order.filter(id => indegree.get(id) === 0);

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const next of successors.get(id)) {
      layer.set(next, Math.max(layer.get(next), layer.get(id) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  // A residual cycle would leave nodes unqueued. removeCycles guarantees this
  // cannot happen; assert rather than silently laying out a broken graph.
  if (queue.length !== order.length) {
    throw new Error('graph-layout: layering received a graph that still contains a cycle.');
  }

  return layer;
}

function medianOf(values, fallback) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Order nodes within each layer to reduce edge crossings.
 *
 * Two fixed sweeps — down, then up — placing each node at the median position of
 * its neighbours in the adjacent layer. Median rather than mean because it is
 * the standard heuristic and, on integer positions, produces exactly assertable
 * orderings. A node with no neighbour in the reference layer keeps its current
 * index, which is what makes the sort stable.
 */
function orderLayers(nodes, edges, layer, config = LAYOUT) {
  const maxLayer = Math.max(0, ...nodes.map(node => layer.get(node.id)));
  const layers = [];
  for (let index = 0; index <= maxLayer; index += 1) layers.push([]);
  for (const node of nodes) layers[layer.get(node.id)].push(node.id);

  const predecessors = new Map(nodes.map(node => [node.id, []]));
  const successors = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!predecessors.has(edge.to) || !successors.has(edge.from)) continue;
    predecessors.get(edge.to).push(edge.from);
    successors.get(edge.from).push(edge.to);
  }

  const positionsIn = (layerIndex) => {
    const map = new Map();
    (layers[layerIndex] || []).forEach((id, index) => map.set(id, index));
    return map;
  };

  const sweep = (layerIndex, referenceIndex, relation) => {
    const reference = positionsIn(referenceIndex);
    const current = layers[layerIndex];
    const keyed = current.map((id, index) => {
      const neighbourPositions = relation.get(id)
        .map(other => reference.get(other))
        .filter(position => position !== undefined);
      return { id, index, key: medianOf(neighbourPositions, index) };
    });
    keyed.sort((a, b) => a.key - b.key || a.index - b.index);
    layers[layerIndex] = keyed.map(entry => entry.id);
  };

  for (let pass = 0; pass < config.orderingSweeps; pass += 1) {
    for (let index = 1; index <= maxLayer; index += 1) sweep(index, index - 1, predecessors);
    for (let index = maxLayer - 1; index >= 0; index -= 1) sweep(index, index + 1, successors);
  }

  return layers;
}

/**
 * Lay a validated spec out into absolute coordinates.
 *
 * Returns positioned nodes, orthogonal edge paths, and the viewBox that contains
 * them. Edges leave the bottom of their source, travel along a horizontal
 * channel in the gap between layers, and enter the top of their target; the
 * channel is offset per edge so parallel runs do not overlap.
 */
function layoutGraph(spec, options = {}) {
  const config = { ...LAYOUT, ...options };
  const nodes = spec.nodes;
  const { edges: acyclicEdges } = removeCycles(nodes, spec.edges);
  const layer = assignLayers(nodes, acyclicEdges);
  const layers = orderLayers(nodes, acyclicEdges, layer, config);

  const widest = Math.max(1, ...layers.map(ids => ids.length));
  const contentWidth = widest * config.nodeWidth + (widest - 1) * config.gapX;
  const centreX = config.padding + contentWidth / 2;

  const placed = new Map();
  layers.forEach((ids, layerIndex) => {
    const rowWidth = ids.length * config.nodeWidth + (ids.length - 1) * config.gapX;
    const startX = centreX - rowWidth / 2;
    ids.forEach((id, positionIndex) => {
      const x = startX + positionIndex * (config.nodeWidth + config.gapX);
      const y = config.padding + layerIndex * (config.nodeHeight + config.gapY);
      placed.set(id, {
        x,
        y,
        width: config.nodeWidth,
        height: config.nodeHeight,
        centreX: x + config.nodeWidth / 2,
        layer: layerIndex,
        position: positionIndex,
      });
    });
  });

  const labelById = new Map(nodes.map(node => [node.id, node.label]));
  const positionedNodes = nodes.map(node => {
    const box = placed.get(node.id);
    return {
      id: node.id,
      label: node.label,
      lines: wrapLabel(node.label, config),
      ...box,
    };
  });

  // Roughly a monospace-width estimate — there is no server-side text
  // measurement (see the file-level comment) — used only to keep a label
  // clear of node boxes, not for layout sizing.
  const estimateLabelBox = (label) => ({
    width: Math.min(String(label || '').length * 6.4 + 8, 200),
    height: 14,
  });
  const boxesOverlap = (ax, ay, aw, ah, box, padding = 4) => {
    const left = ax - aw / 2 - padding;
    const right = ax + aw / 2 + padding;
    const top = ay - ah / 2 - padding;
    const bottom = ay + ah / 2 + padding;
    return !(right < box.x || left > box.x + box.width || bottom < box.y || top > box.y + box.height);
  };

  // Group parallel runs so each gets its own channel offset.
  const channelUse = new Map();
  // Tracks how far right a same-column skip-layer jog (below) extends, so the
  // canvas can widen to fit it. Clamping the jog back inside the existing
  // content bounds instead would defeat the point when the layer it needs to
  // clear is only one node wide — there would be no room to jog into at all.
  let jogRightExtent = 0;
  const routedEdges = acyclicEdges.map((edge, index) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    const startY = from.y + from.height;
    const endY = to.y;

    const channelKey = `${from.layer}:${to.layer}`;
    const used = channelUse.get(channelKey) || 0;
    channelUse.set(channelKey, used + 1);

    // Layering guarantees layer(to) > layer(from), so the span is always at
    // least one gapY and there is real room for a channel.
    const span = endY - startY;
    const midpoint = startY + span / 2;
    // Fan successive edges either side of the midpoint so parallel horizontal
    // runs stay distinguishable, then clamp so the channel cannot escape the gap.
    const fan = (used % 5) * 6 - 12;
    const channelY = Math.min(Math.max(midpoint + fan, startY + 6), endY - 6);

    // A same-column edge that skips over an intermediate layer (typically a
    // cycle-reversed edge) would otherwise draw a straight vertical line
    // through any node sitting in the skipped layer at this x position. Jog
    // sideways around it rather than drawing through the node's box.
    const spansMultipleLayers = to.layer - from.layer > 1;
    const sameColumn = Math.abs(from.centreX - to.centreX) < config.nodeWidth / 2;
    let path;
    let labelX = (from.centreX + to.centreX) / 2;
    let labelY = channelY - 4;

    if (spansMultipleLayers && sameColumn) {
      const jogX = from.centreX + config.nodeWidth / 2 + config.gapX / 2;
      jogRightExtent = Math.max(jogRightExtent, jogX);
      const jogStartY = startY + config.gapY / 3;
      const jogEndY = endY - config.gapY / 3;
      path = `M ${from.centreX.toFixed(1)} ${startY.toFixed(1)} `
        + `V ${jogStartY.toFixed(1)} `
        + `H ${jogX.toFixed(1)} `
        + `V ${jogEndY.toFixed(1)} `
        + `H ${to.centreX.toFixed(1)} `
        + `V ${endY.toFixed(1)}`;
      labelX = jogX;
      labelY = (jogStartY + jogEndY) / 2;
    } else {
      path = `M ${from.centreX.toFixed(1)} ${startY.toFixed(1)} `
        + `V ${channelY.toFixed(1)} `
        + `H ${to.centreX.toFixed(1)} `
        + `V ${endY.toFixed(1)}`;
    }

    // Nudge the label off any node box it would otherwise sit on top of,
    // trying a few alternate positions within the channel before giving up
    // and keeping the original placement (a legibility best-effort, not a
    // hard guarantee — there is no server-side text measurement to do more).
    if (edge.label) {
      const labelBox = estimateLabelBox(edge.label);
      const collidesAt = (y) => positionedNodes.some(node => (
        boxesOverlap(labelX, y, labelBox.width, labelBox.height, node)
      ));
      if (collidesAt(labelY)) {
        const candidates = [endY - 10, startY + 10, channelY - 12, channelY + 12]
          .map(y => Math.min(Math.max(y, startY + 6), endY - 6));
        const clear = candidates.find(y => !collidesAt(y));
        if (clear !== undefined) labelY = clear;
      }
    }

    return {
      index,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      reversed: Boolean(edge.reversed),
      path,
      labelX,
      labelY,
      fromLabel: labelById.get(edge.from) || edge.from,
      toLabel: labelById.get(edge.to) || edge.to,
    };
  });

  const maxX = Math.max(jogRightExtent, ...positionedNodes.map(node => node.x + node.width));
  const maxY = Math.max(...positionedNodes.map(node => node.y + node.height));

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    layers,
    width: Math.round(maxX + config.padding),
    height: Math.round(maxY + config.padding),
    config,
  };
}

module.exports = {
  LAYOUT,
  wrapLabel,
  removeCycles,
  assignLayers,
  orderLayers,
  medianOf,
  layoutGraph,
};
