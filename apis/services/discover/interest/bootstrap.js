'use strict';
// One-time, per-student cold start.
//
// Two gaps this closes, both inherited:
//
// 1. The interest graph used to live in ai_db. Rather than a cross-schema data
//    migration, each student's old nodes are pulled once over the internal API
//    the first time they open Discover, and `importedLegacyGraphAt` records
//    that it happened. Idempotent, and a student who never returns costs
//    nothing.
//
// 2. Onboarding interests never reached the graph at all. They were stored in
//    StudentLearningProfile and formatted into a *separate* tutor prompt block,
//    so a brand-new student's "for you" tab was pure recency — the personalised
//    feed had nothing to personalise with on day one, even though they had just
//    told us what they liked.
//
// Both paths write through interest/store.js's seedNode, so the weights, the
// clamp and the decay behave exactly like any other node.

const { seedNode } = require('./store');
const { SEED_WEIGHTS } = require('./promote');
const { canonicalKey, topicFromLabel } = require('./vocab');
const { registerTopic } = require('./registry');

const IMPORT_TIMEOUT_MS = 8000;
const MAX_IMPORTED_NODES = 200;

async function fetchInternalJson(url, { token, timeoutMs = IMPORT_TIMEOUT_MS, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'x-internal-service-token': token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Pull a student's pre-existing graph and onboarding interests out of
 * services/ai. Returns empty structures on any failure — a student whose
 * history cannot be reached still gets a working (if cold) Discover.
 */
async function fetchLegacyProfile({ studentId, aiServiceUrl, token, fetchImpl = fetch, logger = console }) {
  if (!token || !aiServiceUrl) return { nodes: [], interests: [] };
  const base = String(aiServiceUrl).replace(/\/+$/, '');
  const results = await Promise.allSettled([
    fetchInternalJson(`${base}/api/ai/internal/interest-graph?studentId=${encodeURIComponent(studentId)}`, { token, fetchImpl }),
    fetchInternalJson(`${base}/api/ai/internal/learning-profile?studentId=${encodeURIComponent(studentId)}`, { token, fetchImpl }),
  ]);

  const [graph, profile] = results;
  if (graph.status === 'rejected') {
    logger.warn?.(`[discover] legacy interest graph unavailable for ${studentId}: ${graph.reason?.message}`);
  }
  if (profile.status === 'rejected') {
    logger.warn?.(`[discover] onboarding profile unavailable for ${studentId}: ${profile.reason?.message}`);
  }

  return {
    nodes: graph.status === 'fulfilled' && Array.isArray(graph.value?.nodes) ? graph.value.nodes : [],
    interests: profile.status === 'fulfilled' && Array.isArray(profile.value?.interests) ? profile.value.interests : [],
    // Whether services/ai actually answered. An empty result from a reachable
    // service is a real answer ("this student has no history"); an empty result
    // from an unreachable one is not, and must not be recorded as one.
    reachable: graph.status === 'fulfilled' || profile.status === 'fulfilled',
  };
}

/**
 * Copy legacy nodes across. Keys are carried verbatim: the seed vocabulary uses
 * the same 41 keys the old taxonomy did, precisely so this import is a rename-
 * free copy. A node whose key is no longer in the vocabulary is still imported
 * — it ranks and displays under its raw key rather than being thrown away.
 */
// Concurrency for the batches below, not a magic number: bounds how many
// connections one import can hold from the pool at once.
const IMPORT_CHUNK_SIZE = 20;

async function importLegacyNodes(prisma, { studentId, nodes, now = new Date() }) {
  const candidates = nodes.slice(0, MAX_IMPORTED_NODES).filter(node => {
    const weight = Number(node?.weight);
    return Boolean(node?.kind) && Boolean(node?.key) && Number.isFinite(weight) && weight > 0;
  });

  // Runs in small concurrent chunks rather than one node at a time. Each
  // seedNode is a read-then-upsert pair, so up to 200 nodes sequentially was
  // up to 400 round-trips end to end. Different (kind, key) pairs never
  // conflict with each other, so this is safe to parallelize — unlike
  // applySignal's same-key weight update in store.js, which genuinely needs
  // serialization (see runSerializable there).
  let imported = 0;
  for (let i = 0; i < candidates.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + IMPORT_CHUNK_SIZE);
    await Promise.all(chunk.map(node => seedNode(prisma, {
      studentId, kind: node.kind, key: node.key, weight: Number(node.weight), origin: 'imported', now,
    })));
    imported += chunk.length;
  }
  return imported;
}

/**
 * Turn onboarding answers ("Space and technology", "Animals and nature") into
 * real nodes. The multiselect options are free text from onboarding.js, so they
 * go through canonicalKey like anything else; an option that maps onto a seed
 * topic reuses it, and one that does not creates a topic.
 */
async function seedOnboardingInterests(prisma, vocab, { studentId, interests = [], now = new Date() }) {
  let seeded = 0;
  for (const raw of interests.slice(0, 8)) {
    const label = String(raw || '').trim();
    if (!label) continue;
    const key = canonicalKey(label);
    if (!key) continue;

    if (!vocab.has(key)) {
      const topic = topicFromLabel(label, null);
      if (topic) await registerTopic(prisma, vocab, topic);
    }
    await seedNode(prisma, {
      studentId, kind: 'topic', key,
      weight: SEED_WEIGHTS.onboarding, origin: 'onboarding', now,
    });
    seeded += 1;
  }
  return seeded;
}

// Per-process backoff for students whose import could not reach services/ai.
// Without it, an ai outage would put a timing-out HTTP call in front of every
// feed request; with it, a student retries at most once a minute.
const RETRY_BACKOFF_MS = 60000;
const retryAfter = new Map();

/**
 * Run the cold start once per student. Cheap and safe to call on every feed
 * request: after the first success it is a single indexed profile read.
 *
 * The stamp is only written when services/ai actually answered. An earlier
 * version stamped unconditionally, which meant a student who happened to open
 * Discover while ai was down lost their entire pre-existing interest graph
 * permanently — the import never ran again. An empty answer from a reachable
 * service is still an answer and does stamp.
 */
async function ensureStudentBootstrapped(prisma, vocab, {
  studentId, aiServiceUrl, token, now = new Date(), fetchImpl = fetch, logger = console,
} = {}) {
  if (prisma.preferenceControl && await require('../preference/service').blocked(prisma, studentId, '*')) {
    return { ran: false, imported: 0, seeded: 0 };
  }
  const profile = await prisma.studentInterestProfile.findUnique({
    where: { studentId },
    select: { importedLegacyGraphAt: true },
  });
  if (profile?.importedLegacyGraphAt) return { ran: false, imported: 0, seeded: 0 };

  const waitUntil = retryAfter.get(studentId);
  if (waitUntil && waitUntil > now.getTime()) return { ran: false, imported: 0, seeded: 0, deferred: true };

  const { nodes, interests, reachable } = await fetchLegacyProfile({ studentId, aiServiceUrl, token, fetchImpl, logger });
  if (!reachable) {
    retryAfter.set(studentId, now.getTime() + RETRY_BACKOFF_MS);
    logger.warn?.(`[discover] cold start deferred for ${studentId}: services/ai unreachable`);
    return { ran: false, imported: 0, seeded: 0, deferred: true };
  }
  retryAfter.delete(studentId);

  const applyImport = async tx => {
  if (tx.preferenceControl && await require('../preference/service').blocked(tx, studentId, '*')) return { ran: false, imported: 0, seeded: 0 };
  const current = await tx.studentInterestProfile.findUnique({ where: { studentId }, select: { importedLegacyGraphAt: true } });
  if (current?.importedLegacyGraphAt) return { ran: false, imported: 0, seeded: 0 };
  const imported = await importLegacyNodes(tx, { studentId, nodes, now });
  const seeded = await seedOnboardingInterests(tx, vocab, { studentId, interests, now });

  await tx.studentInterestProfile.upsert({
    where: { studentId },
    create: { studentId, summary: {}, promptContext: '', signalCount: 0, importedLegacyGraphAt: now },
    update: { importedLegacyGraphAt: now },
  });

  return { ran: true, imported, seeded };
  };
  return prisma.preferenceControl
    ? require('../preference/service').withPreferenceLock(prisma, studentId, applyImport)
    : applyImport(prisma);
}

module.exports = {
  IMPORT_TIMEOUT_MS, MAX_IMPORTED_NODES, RETRY_BACKOFF_MS,
  fetchLegacyProfile, importLegacyNodes, seedOnboardingInterests, ensureStudentBootstrapped,
  // Test seam: the backoff is per-process state.
  _resetRetryBackoff: () => retryAfter.clear(),
};
