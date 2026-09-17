'use strict';
// Interest graph maths — ported from services/ai/interest-graph.js.
//
// Nodes are genres, topics and entities. Edges are weighted affinities that
// decay with time, so the graph tracks what a student cares about *now*.
// Everything here is deterministic: ranking a feed must not cost an LLM call,
// and no function in this file may consult a model, directly or indirectly.
//
// The one structural change from the predecessor is that the topic taxonomy is
// no longer baked in — every function that needs a label, a cluster or a set of
// matchers takes a `vocab` (see ./vocab.js). The arithmetic is unchanged, and
// test/graph.test.js pins it against the original's outputs.

const { CLUSTERS, DEFAULT_CLUSTER, createVocabulary } = require('./vocab');

// ── genres ───────────────────────────────────────────────────────────────────
// Fixed, unlike topics: these are feed sections, not interests. Growing them is
// a product decision, not something a student's reading should do on its own.
const GENRES = Object.freeze([
  { key: 'top',           label: 'Top Stories' },
  { key: 'india',         label: 'India' },
  { key: 'business',      label: 'Business' },
  { key: 'technology',    label: 'Technology' },
  { key: 'science',       label: 'Science' },
  { key: 'health',        label: 'Health' },
  { key: 'education',     label: 'Education' },
  { key: 'sports',        label: 'Sports' },
  { key: 'entertainment', label: 'Culture' },
  { key: 'world',         label: 'World' },
  { key: 'interests',     label: 'Your interests' },   // where hunted articles land
]);

const GENRE_KEYS = GENRES.map(g => g.key);
const GENRE_LABEL = new Map(GENRES.map(g => [g.key, g.label]));

const DEFAULT_VOCAB = createVocabulary();

// ── extraction ───────────────────────────────────────────────────────────────
function haystack(article) {
  return ` ${String(article?.title || '')} ${String(article?.summary || '')} `
    .toLowerCase().replace(/\s+/g, ' ');
}

function extractTopics(article, vocab = DEFAULT_VOCAB) {
  const text = haystack(article);
  const hits = [];
  for (const topic of vocab.matchers()) {
    let score = 0;
    for (const re of topic.res) if (re.test(text)) score += 1;
    if (score > 0) hits.push({ key: topic.key, cluster: topic.cluster, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 6);
}

const ENTITY_STOP = new Set([
  'The','A','An','And','But','For','From','With','After','Before','Over','Under',
  'How','Why','What','When','Where','Who','This','That','These','Those','New','Live',
  'Watch','Update','Updates','BBC','News','Sport','UK','US','Mr','Mrs','Dr','Sir',
  'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
]);

// A proper-noun token: Title case (Delhi), internal caps (OpenAI, iPhone) or a
// bare acronym (NASA, ISRO). The Title-case-only pattern split "OpenAI" into
// "Open" and dropped "NASA" completely.
const NOUN = "(?:[A-Z][a-zA-Z'’]*[a-z][a-zA-Z'’]*|[A-Z]{2,6})";
const ENTITY_RE = new RegExp(`\\b(${NOUN})(?:\\s+(${NOUN}))?(?:\\s+(${NOUN}))?`, 'g');

function extractEntities(article) {
  const raw = `${article?.title || ''}. ${article?.summary || ''}`;
  const found = new Map();
  let m;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(raw)) !== null) {
    let parts = [m[1], m[2], m[3]].filter(Boolean);
    // Trim leading/trailing stopwords rather than discarding the whole run,
    // so "The BBC" still yields "BBC" and "India beat Australia" survives.
    while (parts.length && ENTITY_STOP.has(parts[0])) parts = parts.slice(1);
    while (parts.length && ENTITY_STOP.has(parts[parts.length - 1])) parts = parts.slice(0, -1);
    if (!parts.length) continue;
    const name = parts.join(' ');
    if (name.length < 3 || name.length > 46) continue;
    if (/^[A-Z]{2,6}$/.test(name) && ENTITY_STOP.has(name)) continue;
    found.set(name, (found.get(name) || 0) + 1);
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }));
}

/** Sparse unit-ish vector for an article: genre + topics. */
function articleVector(article, vocab = DEFAULT_VOCAB) {
  const vec = Object.create(null);
  const genre = String(article?.category || '').toLowerCase();
  if (genre) vec[`g:${genre}`] = 1;
  // Prefer facets extracted once at write time; re-parsing article text on
  // every feed request is the thing this field exists to avoid.
  const topics = Array.isArray(article?.topics) && article.topics.length
    ? article.topics.map(t => (typeof t === 'string' ? { key: t, score: 1 } : t))
    : extractTopics(article, vocab);
  for (const t of topics) {
    if (!t?.key) continue;
    vec[`t:${t.key}`] = Math.min(1, 0.45 + (Number(t.score) || 1) * 0.22);
  }
  return vec;
}

// ── signals ──────────────────────────────────────────────────────────────────
const SIGNAL_WEIGHTS = Object.freeze({
  impression: 0.06,   // it scrolled past their eyes
  open:       1.00,   // they opened the story
  dwell:      1.60,   // per full minute of reading, capped by caller
  share:      2.00,
  skip:      -0.45,   // explicitly dismissed
  headline_dwell: 0,  // recorded for analytics/dwell stats only, never ranked
});
const SIGNAL_KINDS = Object.freeze(Object.keys(SIGNAL_WEIGHTS));
const HALF_LIFE_DAYS = 21;

/** Exponential decay so the graph reflects present interest, not history. */
function decayFactor(fromDate, now = new Date()) {
  const days = Math.max(0, (now.getTime() - new Date(fromDate).getTime()) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

function signalWeight(kind, dwellMs = 0) {
  if (kind === 'dwell') {
    const minutes = Math.min(4, Math.max(0, Number(dwellMs) || 0) / 60000);
    return SIGNAL_WEIGHTS.dwell * minutes;
  }
  return SIGNAL_WEIGHTS[kind] ?? 0;
}

// ── ranking ──────────────────────────────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { na += a[k] * a[k]; if (k in b) dot += a[k] * b[k]; }
  for (const k in b) nb += b[k] * b[k];
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function recencyScore(publishedAt, now = new Date()) {
  const hours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3600000);
  return Math.pow(0.5, hours / 30);      // ~30h half-life
}

/**
 * A 1-2 signal vector's cosine similarity is noisy — over-trusting it early
 * narrows the feed exactly when it should still be exploring. Callers with a
 * thin profile should widen the exploration lane; `rankArticles`'s own
 * default stays 0.18 (unparameterised calls, and the port-equivalence test
 * pinning it against the predecessor, are both untouched by this).
 */
function explorationRateFor(vectorSize) {
  if (vectorSize < 5) return 0.35;
  if (vectorSize < 12) return 0.24;
  return 0.18;
}

/**
 * Personalised ranking. Relevance is real but never total: a fixed exploration
 * term keeps unfamiliar genres reachable, otherwise the graph narrows onto
 * whatever the student clicked first and never widens again.
 */
function rankArticles(articles, studentVector, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const explore = options.explore ?? 0.18;
  const vocab = options.vocab || DEFAULT_VOCAB;
  const hasProfile = studentVector && Object.keys(studentVector).length > 0;

  const scored = articles.map(article => {
    const vec = articleVector(article, vocab);
    const affinity = hasProfile ? cosine(vec, studentVector) : 0;
    const recency = recencyScore(article.publishedAt, now);
    const score = hasProfile
      ? (0.62 * affinity + 0.38 * recency)
      : recency;
    return { article, vec, affinity, recency, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (!hasProfile) return scored;

  // Interleave a slice of the freshest unseen genres so the feed can surprise.
  const seenGenres = new Set();
  const primary = [];
  const exploreRows = [];
  for (const row of scored) {
    const genre = row.article.category;
    if (row.affinity < 0.05 && !seenGenres.has(genre)) {
      seenGenres.add(genre);
      exploreRows.push(row);
    } else {
      primary.push(row);
    }
  }
  const out = [];
  const everyN = Math.max(3, Math.round(1 / explore));
  let ei = 0;
  primary.forEach((row, i) => {
    out.push(row);
    if ((i + 1) % everyN === 0 && ei < exploreRows.length) out.push(exploreRows[ei++]);
  });
  while (ei < exploreRows.length) out.push(exploreRows[ei++]);
  return out;
}

// ── derived affinities (the readable summary of the graph) ───────────────────
function shannonEvenness(weights) {
  const vals = weights.filter(w => w > 0);
  if (vals.length < 2) return 0;
  const total = vals.reduce((s, w) => s + w, 0);
  if (!total) return 0;
  let h = 0;
  for (const w of vals) { const p = w / total; h -= p * Math.log(p); }
  return h / Math.log(vals.length);          // 0 = narrow, 1 = perfectly even
}

/**
 * Collapse graph nodes into the handful of numbers teaching actually uses.
 * `nodes`: [{ kind:'genre'|'topic'|'entity', key, weight, origin }]
 */
function deriveAffinities(nodes, vocab = DEFAULT_VOCAB) {
  const topics = nodes.filter(n => n.kind === 'topic' && n.weight > 0);
  const genres = nodes.filter(n => n.kind === 'genre' && n.weight > 0);
  const entities = nodes.filter(n => n.kind === 'entity' && n.weight > 0);
  const total = topics.reduce((s, n) => s + n.weight, 0) || 1;

  const byCluster = Object.fromEntries([...CLUSTERS, DEFAULT_CLUSTER].map(c => [c, 0]));
  for (const n of topics) byCluster[vocab.clusterOf(n.key)] += n.weight;
  const share = c => Number(((byCluster[c] || 0) / total).toFixed(3));

  const civicWeight = topics
    .filter(n => vocab.isCivic(n.key))
    .reduce((s, n) => s + n.weight, 0);

  return {
    topTopics: topics.sort((a, b) => b.weight - a.weight).slice(0, 8)
      .map(n => ({ key: n.key, label: vocab.labelOf(n.key), weight: Number(n.weight.toFixed(3)), origin: n.origin || 'behaviour' })),
    topGenres: genres.sort((a, b) => b.weight - a.weight).slice(0, 5)
      .map(n => ({ key: n.key, label: GENRE_LABEL.get(n.key) || n.key, weight: Number(n.weight.toFixed(3)) })),
    topEntities: entities.sort((a, b) => b.weight - a.weight).slice(0, 8)
      .map(n => ({ key: n.key, weight: Number(n.weight.toFixed(3)) })),
    clusters: Object.fromEntries([...CLUSTERS, DEFAULT_CLUSTER].map(c => [c, share(c)])),
    techAffinity:      share('tech'),
    scienceAffinity:   share('science'),
    sportsAffinity:    share('sports'),
    cultureAffinity:   share('culture'),   // film, music, celebrity, gaming, art
    businessAffinity:  share('business'),
    // Interests outside the curated eight clusters — hobbies and specialist
    // pursuits. This is the share the closed taxonomy used to lose entirely.
    personalAffinity:  share(DEFAULT_CLUSTER),
    // Current-affairs engagement — a measure of attention, not of alignment.
    civicEngagement:   Number((civicWeight / total).toFixed(3)),
    // How spread the reading is across genres. Low means a narrow diet, which
    // is a media-literacy prompt for the teacher, not a judgement of the child.
    viewpointDiversity: Number(shannonEvenness(genres.map(n => n.weight)).toFixed(3)),
    signalStrength: Number(Math.min(1, total / 12).toFixed(3)),   // confidence
  };
}

/**
 * Short block injected into the tutor prompt.
 *
 * The closing sentence is load-bearing and must not be softened: it is the only
 * thing standing between "use the student's interests to pick an analogy" and
 * "teach them less because they like sport". Interests may change the *skin* of
 * an explanation, never its content, difficulty or correctness.
 */
function formatInterestsForPrompt(summary) {
  if (!summary || !summary.topTopics?.length) return '';
  if ((summary.signalStrength || 0) < 0.15) return '';   // too thin to act on
  const topics = summary.topTopics.slice(0, 5).map(t => t.label).join(', ');
  const lines = [`Real-world interests (from the student's own reading): ${topics}.`];

  // Interests the student explicitly confirmed are worth more than inferred
  // ones, and saying so lets the tutor lead with something they chose.
  const confirmed = summary.topTopics.filter(t => t.origin === 'confirmed').slice(0, 3);
  if (confirmed.length) {
    lines.push(`They explicitly follow: ${confirmed.map(t => t.label).join(', ')}.`);
  }
  if (summary.topEntities?.length) {
    lines.push(`Names they follow: ${summary.topEntities.slice(0, 4).map(e => e.key).join(', ')}.`);
  }
  const strong = Object.entries({
    technology: summary.techAffinity, science: summary.scienceAffinity,
    sport: summary.sportsAffinity, culture: summary.cultureAffinity,
    business: summary.businessAffinity, 'current affairs': summary.civicEngagement,
    'personal hobbies': summary.personalAffinity,
  }).filter(([, v]) => v >= 0.18).map(([k]) => k);
  if (strong.length) lines.push(`Leans towards: ${strong.join(', ')}.`);
  lines.push('Use these only to pick examples and analogies. Never change the academic content, difficulty, or correctness of an answer to match an interest.');
  return lines.join('\n');
}

module.exports = {
  GENRES, GENRE_KEYS, GENRE_LABEL, DEFAULT_VOCAB,
  SIGNAL_WEIGHTS, SIGNAL_KINDS, HALF_LIFE_DAYS,
  haystack, extractTopics, extractEntities, articleVector,
  decayFactor, signalWeight, cosine, recencyScore, explorationRateFor, rankArticles,
  shannonEvenness, deriveAffinities, formatInterestsForPrompt,
};
