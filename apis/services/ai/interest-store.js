'use strict';
// Persistence for the Interest Graph: apply engagement signals to a student's
// nodes and edges, then derive the readable summary the tutor consumes.

const {
  articleVector, extractTopics, extractEntities,
  decayFactor, signalWeight, deriveAffinities, formatInterestsForPrompt,
  TOPIC_BY_KEY,
} = require('./interest-graph');

const MAX_NODES_PER_STUDENT = 400;

function articleFacets(article) {
  const topics = Array.isArray(article.topics) && article.topics.length
    ? article.topics
    : extractTopics(article).map(t => t.key);
  const entities = Array.isArray(article.entities) && article.entities.length
    ? article.entities
    : extractEntities(article).map(e => e.key);
  return { topics, entities };
}

/**
 * Fold one engagement signal into the graph.
 * Decay is applied lazily at write time: a node's stored weight is aged from
 * its own lastSeen before the new delta lands, so a dormant interest fades
 * without needing a sweep job.
 */
async function applySignal(prisma, { studentId, article, kind, dwellMs = 0, now = new Date() }) {
  const delta = signalWeight(kind, dwellMs);
  if (!delta) return { applied: 0 };

  const { topics, entities } = articleFacets(article);
  const genre = String(article.category || '').toLowerCase();

  const targets = [];
  if (genre) targets.push({ kind: 'genre', key: genre, scale: 1 });
  for (const t of topics) targets.push({ kind: 'topic', key: t, scale: 0.9 });
  for (const e of entities.slice(0, 3)) targets.push({ kind: 'entity', key: e, scale: 0.5 });
  if (!targets.length) return { applied: 0 };

  await prisma.$transaction(async tx => {
    for (const target of targets) {
      const existing = await tx.studentInterestNode.findUnique({
        where: { studentId_kind_key: { studentId, kind: target.kind, key: target.key } },
        select: { weight: true, hits: true, lastSeen: true },
      });
      const aged = existing ? existing.weight * decayFactor(existing.lastSeen, now) : 0;
      const weight = Math.max(0, Math.min(50, aged + delta * target.scale));
      await tx.studentInterestNode.upsert({
        where: { studentId_kind_key: { studentId, kind: target.kind, key: target.key } },
        create: { studentId, kind: target.kind, key: target.key, weight, hits: 1, lastSeen: now },
        update: { weight, hits: { increment: 1 }, lastSeen: now },
      });
    }

    // Edges: genre → topic, and topic ↔ topic co-occurrence. These are what
    // make it a graph rather than a bag of counters — they capture that this
    // student meets 'ai' *through* technology, or 'space' alongside 'physics'.
    const edges = [];
    if (genre) for (const t of topics) edges.push(['genre', genre, 'topic', t]);
    for (let i = 0; i < topics.length; i += 1) {
      for (let j = i + 1; j < topics.length; j += 1) edges.push(['topic', topics[i], 'topic', topics[j]]);
    }
    for (const t of topics) for (const e of entities.slice(0, 2)) edges.push(['topic', t, 'entity', e]);

    for (const [fromKind, fromKey, toKind, toKey] of edges.slice(0, 40)) {
      await tx.studentInterestEdge.upsert({
        where: { studentId_fromKind_fromKey_toKind_toKey: { studentId, fromKind, fromKey, toKind, toKey } },
        create: { studentId, fromKind, fromKey, toKind, toKey, weight: Math.abs(delta) * 0.6 },
        update: { weight: { increment: Math.abs(delta) * 0.6 } },
      });
    }
  });

  return { applied: targets.length };
}

/** Current, decay-adjusted nodes for a student. */
async function loadNodes(prisma, studentId, now = new Date()) {
  const rows = await prisma.studentInterestNode.findMany({
    where: { studentId },
    orderBy: { weight: 'desc' },
    take: MAX_NODES_PER_STUDENT,
  });
  return rows
    .map(r => ({ kind: r.kind, key: r.key, hits: r.hits, lastSeen: r.lastSeen,
                 weight: r.weight * decayFactor(r.lastSeen, now) }))
    .filter(n => n.weight > 0.01);
}

/** The sparse preference vector used to rank the feed. */
function nodesToVector(nodes) {
  const vec = Object.create(null);
  for (const n of nodes) {
    if (n.kind === 'genre') vec[`g:${n.key}`] = n.weight;
    else if (n.kind === 'topic') vec[`t:${n.key}`] = n.weight;
  }
  return vec;
}

/** Recompute the stored summary + tutor prompt block. */
async function rebuildProfile(prisma, studentId, now = new Date()) {
  const nodes = await loadNodes(prisma, studentId, now);
  const summary = deriveAffinities(nodes);
  const promptContext = formatInterestsForPrompt(summary);
  const signalCount = await prisma.studentNewsSignal.count({ where: { studentId } });

  await prisma.studentInterestProfile.upsert({
    where: { studentId },
    create: { studentId, summary, promptContext, signalCount },
    update: { summary, promptContext, signalCount },
  });
  return { summary, promptContext, nodes };
}

/** Graph shaped for the client visualisation. */
async function loadGraph(prisma, studentId, now = new Date()) {
  const nodes = await loadNodes(prisma, studentId, now);
  const keep = new Set(nodes.map(n => `${n.kind}:${n.key}`));
  const edgeRows = await prisma.studentInterestEdge.findMany({
    where: { studentId }, orderBy: { weight: 'desc' }, take: 160,
  });
  const edges = edgeRows
    .filter(e => keep.has(`${e.fromKind}:${e.fromKey}`) && keep.has(`${e.toKind}:${e.toKey}`))
    .map(e => ({ from: `${e.fromKind}:${e.fromKey}`, to: `${e.toKind}:${e.toKey}`, weight: Number(e.weight.toFixed(3)) }));

  return {
    nodes: nodes.map(n => ({
      id: `${n.kind}:${n.key}`, kind: n.kind, key: n.key,
      label: n.kind === 'topic' ? (TOPIC_BY_KEY.get(n.key)?.label || n.key) : n.key,
      cluster: n.kind === 'topic' ? (TOPIC_BY_KEY.get(n.key)?.cluster || null) : null,
      weight: Number(n.weight.toFixed(3)), hits: n.hits,
    })),
    edges,
    summary: deriveAffinities(nodes),
  };
}

async function loadInterestPromptContext(prisma, studentId) {
  try {
    const row = await prisma.studentInterestProfile.findUnique({
      where: { studentId }, select: { promptContext: true },
    });
    return String(row?.promptContext || '').slice(0, 900);
  } catch (err) {
    // Falling back to '' is deliberate: the tutor must still answer without
    // interest personalisation. But a DB failure must not look identical to
    // "this student has no profile yet", so it gets logged.
    console.warn('[ai] interest prompt context unavailable:', err.message);
    return '';
  }
}

module.exports = {
  applySignal, loadNodes, nodesToVector, rebuildProfile, loadGraph,
  loadInterestPromptContext, articleFacets, MAX_NODES_PER_STUDENT,
};
