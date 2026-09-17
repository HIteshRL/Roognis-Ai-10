'use strict';
// The vocabulary's home in the database.
//
// createVocabulary() in ./vocab.js is pure and in-memory; this is what fills it
// from `interest_topics` at boot and writes new topics back when one is
// promoted. Holding it in a table rather than a constant is the whole
// open-vocabulary change: a topic can now be created at runtime by a student's
// reading, and every replica converges on the same set.

const { SEED_TOPICS, createVocabulary, topicFromLabel } = require('./vocab');

// Cheap, deterministic edit distance — used only as an observational nudge
// below, never to merge keys automatically. Bounded inputs (topic keys are
// <=90 chars), called only on the infrequent "about to create a new topic"
// path, so an O(n*m) table is fine.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * A newly-minted key that is a near-miss of an existing one usually means
 * resolveTopicKey()'s term-matcher didn't catch a synonym that belongs in
 * vocab.js's static ALIASES table — e.g. a new "quadcopters-fpv" alongside
 * an existing "drones". This is purely observational (a log line for a human
 * to review and hand-add an alias), never a gate: MASTERCONTEXT §7 keeps
 * taxonomy decisions out of model/automatic hands, and a fuzzy-match merge
 * would just move that decision from a person to a heuristic.
 */
function warnIfCloseToExisting(vocab, key, { logger = console } = {}) {
  const threshold = key.length <= 6 ? 1 : 2;
  for (const existing of vocab.all()) {
    if (existing.key === key) continue;
    if (levenshtein(existing.key, key) <= threshold) {
      logger.warn?.(`[discover] new topic "${key}" is close to existing "${existing.key}" — consider an ALIASES entry in interest/vocab.js.`);
      return;
    }
  }
}

/**
 * Ensure the curated seeds exist, then build the in-memory vocabulary from
 * everything in the table.
 *
 * Seeds are upserted on every boot so a term-list fix in ./vocab.js reaches an
 * existing database, but `label`/`cluster` are only set on create — a topic the
 * students have been using should not silently rename itself under them.
 */
async function loadVocabulary(prisma, { logger = console } = {}) {
  try {
    for (const seed of SEED_TOPICS) {
      await prisma.interestTopic.upsert({
        where: { key: seed.key },
        create: { key: seed.key, label: seed.label, cluster: seed.cluster, terms: seed.terms, seeded: true },
        update: { terms: seed.terms, seeded: true },
      });
    }
    const rows = await prisma.interestTopic.findMany();
    return createVocabulary(rows);
  } catch (err) {
    // A vocabulary that cannot be read is not a reason to refuse to serve a
    // feed — the seeds alone still rank the curated genres correctly. It is a
    // reason to be loud, because every runtime-grown topic is missing.
    logger.warn?.(`[discover] interest vocabulary unavailable, falling back to seeds: ${err.message}`);
    return createVocabulary();
  }
}

/**
 * Persist a topic and add it to the live vocabulary.
 *
 * `topic` must already have come through topicFromLabel(), i.e. its key is a
 * deterministic function of its label. Never build one by hand from model
 * output — that is the seam this service is careful about.
 */
async function registerTopic(prisma, vocab, topic, { logger = console } = {}) {
  if (!topic?.key) return null;
  const existing = vocab.get(topic.key);
  if (existing) return existing;

  // Checked against the vocabulary as it stands right now, before this key is
  // added to it — otherwise the new key would just match itself.
  warnIfCloseToExisting(vocab, topic.key, { logger });

  const row = await prisma.interestTopic.upsert({
    where: { key: topic.key },
    create: { key: topic.key, label: topic.label, cluster: topic.cluster, terms: topic.terms, seeded: false },
    // A concurrent request may have created it first. Keep whatever is stored:
    // first writer names the topic, and re-labelling it later would change what
    // every student who already holds the node sees it called.
    update: {},
  });
  return vocab.add(row);
}

/** Convenience for the paths that hold a label rather than a topic record. */
async function registerLabel(prisma, vocab, label, cluster) {
  const topic = topicFromLabel(label, cluster);
  if (!topic) return null;
  return registerTopic(prisma, vocab, topic);
}

/**
 * Pull in any of `keys` this process has not seen yet.
 *
 * The vocabulary is per-process, but it grows at runtime: one replica promoting
 * "Drones" leaves every other replica unable to name it, so labels silently
 * degrade to raw keys ('drones' instead of 'Drones') until the next restart.
 * Callers that are about to render topic labels top up first. Cheap: one
 * indexed query, and only when there is actually a miss.
 */
async function ensureTopicsLoaded(prisma, vocab, keys = [], { logger = console } = {}) {
  const missing = [...new Set(keys.filter(key => key && !vocab.has(key)))];
  if (!missing.length) return 0;
  try {
    const rows = await prisma.interestTopic.findMany({ where: { key: { in: missing } } });
    for (const row of rows) vocab.add(row);
    return rows.length;
  } catch (err) {
    // Labels fall back to keys — ugly, not broken. Never fail a feed for this.
    logger.warn?.(`[discover] could not top up interest vocabulary: ${err.message}`);
    return 0;
  }
}

module.exports = { loadVocabulary, registerTopic, registerLabel, ensureTopicsLoaded };
