/**
 * The only place in the visuals pipeline that emits markup.
 *
 * Two invariants hold this together, and both are enforced by tests.
 *
 * 1. EVERY string that reaches the output goes through `escapeSvgText`.
 *    Elements are ours, so the model cannot inject a tag structurally — but
 *    every label is model-authored text landing in a <text> node, and the client
 *    assigns the result with innerHTML. This function is the entire defence.
 *
 * 2. NO literal colour. Structural colour comes from CSS classes bound to
 *    Chroma Bloom tokens, so a generated visual re-themes with the app instead
 *    of freezing one theme's palette into stored output. (`buildInterestGraph`
 *    in frontend/index.html — formerly `interestGraphMarkup` — used to hardcode
 *    several hex values in violation of DESIGN.md §2; as of the 2026-08-22
 *    graph redesign it follows this same colour-via-CSS-class rule, binding
 *    node clusters to the reserved --c-* spectrum instead.)
 *
 * Ids are namespaced per artifact. SVG ids are document-global, so two inline
 * visuals both emitting id="arrow" collide and one silently retargets the
 * other's marker.
 */

/**
 * Escape a string for both text content and attribute values.
 *
 * Covers all five XML predefined entities rather than the three text content
 * strictly needs, so one function is safe in either position and no call site
 * has to decide which context it is in.
 */
function escapeSvgText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Namespace an SVG id to its artifact.
 *
 * The artifact id is a UUID; non-alphanumerics are stripped so the result is a
 * valid NCName regardless of what the caller passes.
 */
function svgId(artifactId, suffix) {
  const safeArtifact = String(artifactId || 'anon').replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'anon';
  const safeSuffix = String(suffix || 'x').replace(/[^A-Za-z0-9-]/g, '') || 'x';
  return `rv-${safeArtifact}-${safeSuffix}`;
}

/**
 * A plain-text equivalent of the map.
 *
 * An aria-label on a twenty-node graph is not an accessible equivalent — it
 * collapses a structure into one unreadable run-on. The relationships are
 * spelled out here instead, for the <desc> and for a visible list beside the
 * figure (DESIGN.md §7).
 */
function conceptMapAltText(spec) {
  const relationships = spec.edges.map(edge => {
    const from = spec.nodes.find(node => node.id === edge.from);
    const to = spec.nodes.find(node => node.id === edge.to);
    const link = edge.label ? ` ${edge.label} ` : ' → ';
    return `${from ? from.label : edge.from}${link}${to ? to.label : edge.to}`;
  });
  return `Concept map: ${spec.title}. ${spec.nodes.length} ideas, ${spec.edges.length} relationships. ${relationships.join('. ')}.`;
}

/** The arrowhead marker, defined once per artifact. */
function arrowMarker(markerId) {
  return `<marker id="${markerId}" viewBox="0 0 8 8" refX="7" refY="4" `
    + `markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
    + `<path class="arrow" d="M 0 1 L 7 4 L 0 7 z"/>`
    + `</marker>`;
}

function renderNode(node) {
  const lines = node.lines.length ? node.lines : [node.label];
  // Vertically centre the wrapped block inside the box.
  const lineHeight = 13;
  const blockHeight = (lines.length - 1) * lineHeight;
  const firstBaseline = node.y + node.height / 2 - blockHeight / 2 + 4;

  const tspans = lines.map((line, index) => (
    `<tspan x="${node.centreX.toFixed(1)}" y="${(firstBaseline + index * lineHeight).toFixed(1)}">`
    + `${escapeSvgText(line)}</tspan>`
  )).join('');

  return `<g class="rv-node">`
    + `<rect class="node" x="${node.x.toFixed(1)}" y="${node.y.toFixed(1)}" `
    + `width="${node.width.toFixed(1)}" height="${node.height.toFixed(1)}" rx="10"/>`
    + `<text class="node-label" text-anchor="middle">${tspans}</text>`
    + `</g>`;
}

function renderEdge(edge, markerId) {
  // A reversed edge was flipped to break a cycle. Point the arrowhead back at
  // the start so the relationship the model asserted is what the reader sees.
  const markerAttr = edge.reversed
    ? `marker-start="url(#${markerId})"`
    : `marker-end="url(#${markerId})"`;

  const label = edge.label
    ? `<text class="edge-label" x="${edge.labelX.toFixed(1)}" y="${edge.labelY.toFixed(1)}" `
      + `text-anchor="middle">${escapeSvgText(edge.label)}</text>`
    : '';

  return `<g class="rv-edge">`
    + `<path class="edge" d="${edge.path}" ${markerAttr}/>`
    + label
    + `</g>`;
}

/**
 * Render a laid-out concept map.
 *
 * `meta.artifactId` namespaces every id. Returns an SVG string with no external
 * references, no script, no style attributes carrying colour, and no animation.
 */
function renderConceptMapSvg(layout, meta = {}) {
  const artifactId = meta.artifactId || 'anon';
  const titleId = svgId(artifactId, 'title');
  const descId = svgId(artifactId, 'desc');
  const markerId = svgId(artifactId, 'arrow');

  const title = escapeSvgText(meta.title || 'Concept map');
  const description = escapeSvgText(meta.altText || title);

  // Edges first so node boxes paint over the channel runs.
  const edges = layout.edges.map(edge => renderEdge(edge, markerId)).join('');
  const nodes = layout.nodes.map(renderNode).join('');

  return `<svg class="rv-svg" viewBox="0 0 ${layout.width} ${layout.height}" `
    + `role="img" aria-labelledby="${titleId} ${descId}" `
    + `xmlns="http://www.w3.org/2000/svg">`
    + `<title id="${titleId}">${title}</title>`
    + `<desc id="${descId}">${description}</desc>`
    + `<defs>${arrowMarker(markerId)}</defs>`
    + `<g class="rv-edges">${edges}</g>`
    + `<g class="rv-nodes">${nodes}</g>`
    + `</svg>`;
}

module.exports = {
  escapeSvgText,
  svgId,
  conceptMapAltText,
  renderConceptMapSvg,
};
