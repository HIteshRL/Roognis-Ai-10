'use strict';
// Persistence for the interest graph: apply engagement signals to a student's
// nodes and edges, then derive the readable summary the tutor consumes.
//
// Ported from services/ai/interest-store.js. The weights, the 400-node cap, the
// clamp and the lazy-decay-at-write behaviour are all unchanged — this is the
// path a student's own behaviour writes through, and no model may touch it.

const {
  extractTopics, extractEntities,
  decayFactor, signalWeight, deriveAffinities, formatInterestsForPrompt,
  DEFAULT_VOCAB, GENRE_LABEL,
} = require('./graph');

const MAX_NODES_PER_STUDENT = 400;
const MAX_SERIALIZATION_RETRIES = 3;

/**
 * Run `fn` in a Serializable transaction, retrying on a write conflict.
 *
 * `applySignal` below reads a node's weight, ages and adds to it in JS, then
 * writes the result back — under the default READ COMMITTED isolation, two
 * concurrent signals for the same (studentId, kind, key) can both read the
 * same starting weight and the later commit silently overwrites the
 * earlier one's contribution (a lost update). Serializable makes Postgres
 * detect that write-write conflict and abort one side (Prisma's P2034)
 * instead of letting it through, so the retry re-reads the now-current
 * weight and adds on top of it correctly.
 */
async function runSerializable(prisma, fn) {
  // A caller already holding the student's privacy lock supplies a transaction
  // client. Reuse it so the raw signal and derived graph commit together.
  if (typeof prisma.$transaction !== 'function') return fn(prisma);
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error?.code === 'P2034' && attempt < MAX_SERIALIZATION_RETRIES) continue;
      throw error;
    }
  }
  return undefined;
}

function articleFacets(article, vocab = DEFAULT_VOCAB) {
  const topics = Array.isArray(article.topics) && article.topics.length
    ? article.topics.map(t => (typeof t === 'string' ? t : t?.key)).filter(Boolean)
    : extractTopics(article, vocab).map(t => t.key);
  const entities = Array.isArray(article.entities) && article.entities.length
    ? article.entities.map(e => (typeof e === 'string' ? e : e?.key)).filter(Boolean)
    : extractEntities(article).map(e => e.key);
  return { topics, entities };
}

/**
 * Fold one engagement signal into the graph.
 * Decay is applied lazily at write time: a node's stored weight is aged from
 * its own lastSeen before the new delta lands, so a dormant interest fades
 * without needing a sweep job.
 */
async function applySignal(prisma, { studentId, article, kind, dwellMs = 0, now = new Date(), vocab = DEFAULT_VOCAB }) {
  const delta = signalWeight(kind, dwellMs);
  if (!delta) return { applied: 0 };

  const { topics, entities } = articleFacets(article, vocab);
  const genre = String(article.category || '').toLowerCase();

  const targets = [];
  if (genre) targets.push({ kind: 'genre', key: genre, scale: 1 });
  for (const t of topics) targets.push({ kind: 'topic', key: t, scale: 0.9 });
  for (const e of entities.slice(0, 3)) targets.push({ kind: 'entity', key: e, scale: 0.5 });
  if (!targets.length) return { applied: 0 };

  await runSerializable(prisma, async tx => {
    if (tx.preferenceControl) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${studentId}))`;
      const { blocked } = require('../preference/service');
      if (await blocked(tx, studentId, '*')) return;
      for (const key of topics) {
        if (await blocked(tx, studentId, key)) return;
        const override = await tx.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey: key } } });
        if (override?.muted || override?.stance === 'DISLIKE') return;
      }
    }
    for (const target of targets) {
      const existing = await tx.interestNode.findUnique({
        where: { studentId_kind_key: { studentId, kind: target.kind, key: target.key } },
        select: { weight: true, hits: true, lastSeen: true, origin: true },
      });
      const aged = existing ? existing.weight * decayFactor(existing.lastSeen, now) : 0;
      const weight = Math.max(0, Math.min(50, aged + delta * target.scale));
      await tx.interestNode.upsert({
        where: { studentId_kind_key: { studentId, kind: target.kind, key: target.key } },
        create: { studentId, kind: target.kind, key: target.key, weight, hits: 1, origin: 'behaviour', lastSeen: now },
        // `origin` is deliberately not updated: an interest the student
        // explicitly confirmed stays 'confirmed' however they later behave.
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

    // `weight` is a magnitude and `sign` is the direction, which is why Math.abs
    // is still right here — what was wrong before is that there was nowhere to
    // put the direction, so a skip (signalWeight -0.45) incremented exactly like
    // an open and the two were indistinguishable downstream.
    //
    // Both are derived from `delta` in plain code. Nothing here is model-chosen.
    const sign = delta < 0 ? -1 : 1;
    const magnitude = Math.abs(delta) * 0.6;
    for (const [fromKind, fromKey, toKind, toKey] of edges.slice(0, 40)) {
      const relationship = fromKind === 'genre' ? 'GENRE_CONTAINS'
        : toKind === 'entity' ? 'TOPIC_MENTIONS'
        : 'TOPIC_CO_OCCURS';
      await tx.interestEdge.upsert({
        where: {
          interest_edges_student_pair_sign_key: { studentId, fromKind, fromKey, toKind, toKey, sign },
        },
        create: {
          studentId, fromKind, fromKey, toKind, toKey, sign, relationship,
          weight: magnitude, source: 'engagement', evidenceRef: article?.id ? String(article.id) : null,
        },
        update: { weight: { increment: magnitude } },
      });
    }
  });

  return { applied: targets.length };
}

/**
 * Seed a node directly, without an article behind it.
 *
 * Used by the two cold-start paths — onboarding answers and a confirmed
 * candidate — where the student has told us something rather than shown us.
 * `origin` is recorded so the graph can distinguish a stated interest from an
 * observed one; the tutor prompt leads with stated ones.
 */
async function seedNode(prisma, { studentId, kind = 'topic', key, weight, origin, now = new Date(), replaceWeight = false }) {
  if (!key) return null;
  if (prisma.preferenceControl) {
    if (await require('../preference/service').blocked(prisma, studentId, kind === 'topic' ? key : '*')) return null;
    if (kind === 'topic') {
      const override = await prisma.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey: key } } });
      if (override?.muted || override?.stance === 'DISLIKE') return null;
    }
  }
  const existing = await prisma.interestNode.findUnique({
    where: { studentId_kind_key: { studentId, kind, key } },
    select: { weight: true, hits: true, lastSeen: true, origin: true },
  });
  const aged = existing ? existing.weight * decayFactor(existing.lastSeen, now) : 0;
  // Seeding tops a node up to the seed weight rather than adding to it, so
  // re-running the import is idempotent and cannot inflate a node.
  const next = Math.max(0, Math.min(50, replaceWeight ? weight : Math.max(aged, weight)));
  return prisma.interestNode.upsert({
    where: { studentId_kind_key: { studentId, kind, key } },
    create: { studentId, kind, key, weight: next, hits: existing?.hits || 0, origin, lastSeen: now },
    update: { weight: next, origin, lastSeen: now },
  });
}

/** Current, decay-adjusted nodes for a student. */
async function loadNodes(prisma, studentId, now = new Date()) {
  let blockedKeys = new Set();
  let blockedHashes = new Set();
  const hash = key => require('node:crypto').createHash('sha256').update(key).digest('hex');
  if (prisma.preferenceControl) {
    const controls = await prisma.preferenceControl.findMany({ where: { studentId, blocked: true } });
    blockedHashes = new Set(controls.map(row => row.scopeHash));
    if (blockedHashes.has(hash('*'))) return [];
    const overrides = await prisma.studentPreference.findMany({ where: { studentId, OR: [{ muted: true }, { stance: 'DISLIKE' }] } });
    blockedKeys = new Set(overrides.map(row => row.topicKey));
  }
  const rows = await prisma.interestNode.findMany({
    where: { studentId },
    orderBy: { weight: 'desc' },
    take: MAX_NODES_PER_STUDENT,
  });
  return rows
    .filter(row => row.kind !== 'topic' || (!blockedKeys.has(row.key) && !blockedHashes.has(hash(row.key))))
    .map(r => ({ kind: r.kind, key: r.key, hits: r.hits, lastSeen: r.lastSeen, origin: r.origin,
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
async function rebuildProfile(prisma, studentId, { now = new Date(), vocab = DEFAULT_VOCAB } = {}) {
  const nodes = await loadNodes(prisma, studentId, now);
  const summary = deriveAffinities(nodes, vocab);
  const promptContext = formatInterestsForPrompt(summary);
  // Video signals feed the same graph as news signals (applySignal is
  // content-shape-generic — see server.js's signal route), so the derived
  // signalCount must count both, not just news.
  const [newsCount, videoCount] = await Promise.all([
    prisma.newsSignal.count({ where: { studentId } }),
    prisma.videoSignal.count({ where: { studentId } }),
  ]);
  const signalCount = newsCount + videoCount;

  await prisma.studentInterestProfile.upsert({
    where: { studentId },
    create: { studentId, summary, promptContext, signalCount },
    update: { summary, promptContext, signalCount },
  });
  return { summary, promptContext, nodes };
}

/** Graph shaped for the client visualisation. */
async function loadGraph(prisma, studentId, { now = new Date(), vocab = DEFAULT_VOCAB } = {}) {
  const nodes = await loadNodes(prisma, studentId, now);
  const keep = new Set(nodes.map(n => `${n.kind}:${n.key}`));
  // Positive edges only. The visualisation shows what a student is drawn
  // toward; negative evidence exists for the signed model, and rendering it
  // here would silently change what the graph means to a student.
  const edgeRows = await prisma.interestEdge.findMany({
    where: { studentId, sign: 1 }, orderBy: { weight: 'desc' }, take: 160,
  });
  const edges = edgeRows
    .filter(e => keep.has(`${e.fromKind}:${e.fromKey}`) && keep.has(`${e.toKind}:${e.toKey}`))
    .map(e => ({ from: `${e.fromKind}:${e.fromKey}`, to: `${e.toKind}:${e.toKey}`, weight: Number(e.weight.toFixed(3)) }));

  return {
    nodes: nodes.map(n => ({
      id: `${n.kind}:${n.key}`, kind: n.kind, key: n.key,
      // Genre nodes used to render their raw key, so the map read "top",
      // "sports", "interests" in lowercase beside properly-titled topics.
      label: n.kind === 'topic' ? vocab.labelOf(n.key)
        : (n.kind === 'genre' ? (GENRE_LABEL.get(n.key) || n.key) : n.key),
      cluster: n.kind === 'topic' ? vocab.clusterOf(n.key) : null,
      origin: n.origin,
      weight: Number(n.weight.toFixed(3)), hits: n.hits,
    })),
    edges,
    summary: deriveAffinities(nodes, vocab),
  };
}

module.exports = {
  applySignal, seedNode, loadNodes, nodesToVector, rebuildProfile, loadGraph,
  articleFacets, MAX_NODES_PER_STUDENT,
};
