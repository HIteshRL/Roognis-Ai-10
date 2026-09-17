'use strict';
// Port-equivalence tests.
//
// interest/graph.js is a port of services/ai/interest-graph.js with the topic
// taxonomy lifted out into a vocabulary object. The arithmetic must not have
// moved: these tests load BOTH modules and assert they agree. If services/ai's
// copy is ever deleted (it is scheduled to be, once the deprecated /api/ai/news
// shims come out), the comparisons skip and the absolute assertions remain.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const graph = require('../interest/graph');
const { createVocabulary, topicFromLabel } = require('../interest/vocab');

let legacy = null;
try {
  legacy = require(path.join(__dirname, '..', '..', 'ai', 'interest-graph.js'));
} catch { /* the predecessor has been removed — absolute assertions still apply */ }

const ARTICLES = [
  { category: 'science',    title: 'NASA telescope spots a distant galaxy',        summary: 'Astronomers report a discovery about space and the moon.', publishedAt: new Date('2026-08-10T09:00:00Z') },
  { category: 'sports',     title: 'India win the test match by six wickets',      summary: 'A cricket innings to remember for the batsman.',           publishedAt: new Date('2026-08-11T09:00:00Z') },
  { category: 'technology', title: 'New chip speeds up machine learning',          summary: 'The semiconductor improves neural network software.',      publishedAt: new Date('2026-08-11T18:00:00Z') },
  { category: 'business',   title: 'Startup founder raises a funding round',       summary: 'The venture capital deal values the unicorn highly.',      publishedAt: new Date('2026-08-09T09:00:00Z') },
];

test('signal weights and half-life are unchanged from the predecessor', () => {
  assert.equal(graph.HALF_LIFE_DAYS, 21);
  assert.deepEqual({ ...graph.SIGNAL_WEIGHTS }, {
    impression: 0.06, open: 1.00, dwell: 1.60, share: 2.00, skip: -0.45,
    // Discover-only: recorded for the reading-stats view, never ranked (weight
    // 0 is the point). There is no ai_db/legacy equivalent of headline-dwell
    // tracking, so it is deliberately excluded from the port-equivalence
    // comparison below rather than backfilled into the predecessor.
    headline_dwell: 0,
  });
  if (legacy) {
    assert.equal(graph.HALF_LIFE_DAYS, legacy.HALF_LIFE_DAYS);
    const { headline_dwell, ...portedWeights } = graph.SIGNAL_WEIGHTS;
    assert.deepEqual({ ...portedWeights }, { ...legacy.SIGNAL_WEIGHTS });
  }
});

test('signalWeight still caps dwell at four minutes', () => {
  assert.equal(graph.signalWeight('open'), 1);
  assert.equal(graph.signalWeight('skip'), -0.45);
  assert.equal(graph.signalWeight('unknown'), 0);
  assert.equal(graph.signalWeight('dwell', 60000), 1.6);
  assert.equal(graph.signalWeight('dwell', 60 * 60 * 1000), graph.signalWeight('dwell', 4 * 60000));
  if (legacy) {
    for (const ms of [0, 1000, 60000, 240000, 9999999]) {
      assert.equal(graph.signalWeight('dwell', ms), legacy.signalWeight('dwell', ms));
    }
  }
});

test('decay halves a node every 21 days, exactly as before', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const later = new Date('2026-01-22T00:00:00Z');
  assert.ok(Math.abs(graph.decayFactor(from, later) - 0.5) < 1e-12);
  assert.equal(graph.decayFactor(later, from), 1, 'a future lastSeen never amplifies a node');
  if (legacy) assert.equal(graph.decayFactor(from, later), legacy.decayFactor(from, later));
});

test('topic extraction agrees with the predecessor on the curated vocabulary', () => {
  if (!legacy) return;
  for (const article of ARTICLES) {
    assert.deepEqual(
      graph.extractTopics(article).map(t => `${t.key}:${t.score}`).sort(),
      legacy.extractTopics(article).map(t => `${t.key}:${t.score}`).sort(),
      `topics differ for "${article.title}"`,
    );
  }
});

test('entity extraction is byte-identical to the predecessor', () => {
  if (!legacy) return;
  for (const article of ARTICLES) {
    assert.deepEqual(graph.extractEntities(article), legacy.extractEntities(article));
  }
});

test('ranking produces the same order as the predecessor for the same inputs', () => {
  if (!legacy) return;
  const now = new Date('2026-08-12T09:00:00Z');
  const vector = { 'g:technology': 3, 't:ai': 2.5, 't:computing': 1.2 };
  assert.deepEqual(
    graph.rankArticles(ARTICLES, vector, { now }).map(r => r.article.title),
    legacy.rankArticles(ARTICLES, vector, { now }).map(r => r.article.title),
  );
});

test('with no profile the feed is pure recency', () => {
  const now = new Date('2026-08-12T09:00:00Z');
  const ordered = graph.rankArticles(ARTICLES, {}, { now }).map(r => r.article.title);
  assert.equal(ordered[0], 'New chip speeds up machine learning', 'the newest story leads');
  assert.equal(ordered.at(-1), 'Startup founder raises a funding round');
});

test('stored facets are reused instead of re-parsing article text', () => {
  // The whole reason DiscoverArticle carries `topics`: ranking runs on every
  // feed request and must never re-run the matchers over the body text.
  const stored = { category: 'sports', title: 'Totally unrelated headline', topics: ['space'], publishedAt: new Date() };
  const vec = graph.articleVector(stored);
  assert.ok('t:space' in vec, 'the stored topic is used');
  assert.ok(!('t:cricket' in vec), 'no re-extraction happened');
});

test('an open-vocabulary topic ranks even though the predecessor cannot see it', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Rock climbing', 'other'));
  const article = {
    category: 'sports', publishedAt: new Date('2026-08-12T08:00:00Z'),
    title: 'Teenager wins bouldering final', summary: 'A rock climbing championship result.',
  };

  assert.equal(graph.extractTopics(article).some(t => t.key === 'rock-climbing'), false,
    'the seed-only vocabulary is blind to it — this is the gap being closed');
  assert.equal(graph.extractTopics(article, vocab).some(t => t.key === 'rock-climbing'), true);
});

test('deriveAffinities keeps hobbies visible instead of dropping them', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Rock climbing', 'other'));
  const nodes = [
    { kind: 'topic', key: 'rock-climbing', weight: 6, origin: 'confirmed' },
    { kind: 'topic', key: 'space', weight: 2, origin: 'behaviour' },
    { kind: 'genre', key: 'sports', weight: 4 },
    { kind: 'genre', key: 'science', weight: 1 },
  ];
  const summary = graph.deriveAffinities(nodes, vocab);

  assert.equal(summary.topTopics[0].key, 'rock-climbing');
  assert.equal(summary.topTopics[0].label, 'Rock climbing', 'labels resolve through the vocabulary, not raw keys');
  assert.equal(summary.topTopics[0].origin, 'confirmed');
  assert.equal(summary.personalAffinity, 0.75, 'an out-of-cluster hobby is measured, not lost');
  assert.ok(summary.viewpointDiversity > 0 && summary.viewpointDiversity <= 1);
});

test('the tutor prompt block is withheld until there is enough signal', () => {
  const thin = graph.deriveAffinities([{ kind: 'topic', key: 'space', weight: 0.5 }]);
  assert.equal(graph.formatInterestsForPrompt(thin), '', 'a single click is not an interest');
  assert.equal(graph.formatInterestsForPrompt(null), '');
  assert.equal(graph.formatInterestsForPrompt({ topTopics: [] }), '');
});

test('explorationRateFor widens the lane for a thin profile and tapers as it grows', () => {
  assert.equal(graph.explorationRateFor(0), 0.35);
  assert.equal(graph.explorationRateFor(4), 0.35);
  assert.equal(graph.explorationRateFor(5), 0.24);
  assert.equal(graph.explorationRateFor(11), 0.24);
  assert.equal(graph.explorationRateFor(12), 0.18, "today's established default, unchanged for a mature profile");
  assert.equal(graph.explorationRateFor(50), 0.18);
});

test('rankArticles keeps its own 0.18 default when no explore option is passed', () => {
  // explorationRateFor is opt-in at the call site (server.js), not baked into
  // rankArticles's own default — the predecessor-parity test above calls
  // rankArticles with a 3-key vector and must see byte-identical interleaving.
  if (!legacy) return;
  const now = new Date('2026-08-12T09:00:00Z');
  const vector = { 'g:technology': 3, 't:ai': 2.5, 't:computing': 1.2 };
  assert.deepEqual(
    graph.rankArticles(ARTICLES, vector, { now }).map(r => r.article.title),
    legacy.rankArticles(ARTICLES, vector, { now }).map(r => r.article.title),
  );
});

test('the prompt block always carries the constraint that bounds it', () => {
  // This sentence is the only thing between "use interests to pick an analogy"
  // and "teach less because they like sport". It must survive every code path.
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Rock climbing', 'other'));
  const summary = graph.deriveAffinities([
    { kind: 'topic', key: 'rock-climbing', weight: 9, origin: 'confirmed' },
    { kind: 'topic', key: 'space', weight: 8, origin: 'behaviour' },
    { kind: 'entity', key: 'ISRO', weight: 3 },
  ], vocab);

  const block = graph.formatInterestsForPrompt(summary);
  assert.match(block, /Never change the academic content, difficulty, or correctness of an answer to match an interest\./);
  assert.match(block, /Use these only to pick examples and analogies\./);
  assert.match(block, /They explicitly follow: Rock climbing/, 'confirmed interests are named as chosen');
  assert.ok(block.length < 900, 'the block stays within the transport cap');
});
