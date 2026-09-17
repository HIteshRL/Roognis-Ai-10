'use strict';
// Interest Graph — turns news engagement into a personal knowledge graph.
//
// Nodes are genres, topics and entities. Edges are weighted affinities that
// decay with time, so the graph tracks what a student cares about *now*.
// Everything here is deterministic: ranking a feed must not cost an LLM call.

// ── genres ───────────────────────────────────────────────────────────────────
const GENRES = Object.freeze([
  { key: 'top',           label: 'Top Stories',   feed: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { key: 'india',         label: 'India',         feed: 'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml' },
  { key: 'business',      label: 'Business',      feed: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { key: 'technology',    label: 'Technology',    feed: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { key: 'science',       label: 'Science',       feed: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { key: 'health',        label: 'Health',        feed: 'https://feeds.bbci.co.uk/news/health/rss.xml' },
  { key: 'education',     label: 'Education',     feed: 'https://feeds.bbci.co.uk/news/education/rss.xml' },
  { key: 'sports',        label: 'Sports',        feed: 'https://feeds.bbci.co.uk/sport/rss.xml' },
  { key: 'entertainment', label: 'Culture',       feed: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml' },
  { key: 'world',         label: 'World',         feed: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
]);

const GENRE_KEYS = GENRES.map(g => g.key);
const GENRE_LABEL = new Map(GENRES.map(g => [g.key, g.label]));

// ── topic taxonomy ───────────────────────────────────────────────────────────
// Curated for a Class 8 audience: each topic is something a tutor could
// realistically anchor a lesson to. `cluster` drives the derived affinities.
const TOPICS = Object.freeze([
  { key: 'space',        label: 'Space',            cluster: 'science', terms: ['space','nasa','isro','satellite','rocket','orbit','mars','moon','asteroid','galaxy','telescope','astronaut'] },
  { key: 'ai',           label: 'AI',               cluster: 'tech',    terms: ['artificial intelligence',' ai ','machine learning','chatbot','neural','algorithm','openai','deepmind','llm'] },
  { key: 'computing',    label: 'Computing',        cluster: 'tech',    terms: ['software','computer','chip','semiconductor','processor','quantum comput','operating system','cloud comput'] },
  { key: 'internet',     label: 'Internet',         cluster: 'tech',    terms: ['internet','social media','online','website','app store','streaming','cyber','hacking','data breach','privacy'] },
  { key: 'mobile',       label: 'Devices',          cluster: 'tech',    terms: ['smartphone','iphone','android','tablet','wearable','gadget','laptop'] },
  { key: 'startups',     label: 'Startups',         cluster: 'business',terms: ['startup','founder','venture capital','funding round','unicorn','entrepreneur'] },
  { key: 'markets',      label: 'Markets',          cluster: 'business',terms: ['stock','share price','market','investor','nasdaq','sensex','nifty','ipo','shares','trading'] },
  { key: 'economy',      label: 'Economy',          cluster: 'business',terms: ['economy','inflation','gdp','recession','interest rate','currency','rupee','dollar','tariff','trade deal'] },
  { key: 'jobs',         label: 'Work',             cluster: 'business',terms: ['jobs','employment','workforce','layoff','hiring','salary','labour','career'] },
  { key: 'climate',      label: 'Climate',          cluster: 'science', terms: ['climate','global warming','emission','carbon','greenhouse','heatwave','glacier','sea level'] },
  { key: 'wildlife',     label: 'Wildlife',         cluster: 'science', terms: ['wildlife','species','animal','conservation','forest','tiger','elephant','coral','biodiversity','extinct'] },
  { key: 'energy',       label: 'Energy',           cluster: 'science', terms: ['energy','solar','renewable','wind farm','nuclear','battery','electric vehicle','fossil fuel'] },
  { key: 'physics',      label: 'Physics',          cluster: 'science', terms: ['physics','particle','quantum','gravity','laser','fusion','relativity'] },
  { key: 'biology',      label: 'Biology',          cluster: 'science', terms: ['dna','gene','cell','evolution','microb','bacteria','virus','protein','ecosystem'] },
  { key: 'chemistry',    label: 'Chemistry',        cluster: 'science', terms: ['chemical','molecule','compound','element','reaction','material science'] },
  { key: 'maths',        label: 'Mathematics',      cluster: 'science', terms: ['mathematic','equation','geometry','algebra','statistic','probability','theorem'] },
  { key: 'health',       label: 'Health',           cluster: 'health',  terms: ['health','hospital','doctor','patient','disease','vaccine','medicine','treatment','surgery'] },
  { key: 'nutrition',    label: 'Nutrition',        cluster: 'health',  terms: ['nutrition','diet','food','obesity','vitamin','protein intake','sugar'] },
  { key: 'wellbeing',    label: 'Wellbeing',        cluster: 'health',  terms: ['mental health','wellbeing','anxiety','stress','sleep','mindfulness'] },
  { key: 'history',      label: 'History',          cluster: 'culture', terms: ['history','historic','ancient','archaeolog','heritage','excavat','museum','civilisation','dynasty'] },
  { key: 'elections',    label: 'Elections',        cluster: 'civic',   terms: ['election','vote','ballot','poll','candidate','campaign','referendum'] },
  { key: 'governance',   label: 'Governance',       cluster: 'civic',   terms: ['government','parliament','minister','policy','budget','legislation','council','administration'] },
  { key: 'law',          label: 'Law & Rights',     cluster: 'civic',   terms: ['court','supreme court','judge','ruling','lawsuit','rights','constitution','legal'] },
  { key: 'diplomacy',    label: 'Diplomacy',        cluster: 'civic',   terms: ['diplomat','treaty','summit','united nations','alliance','embassy','foreign minister','peace talks'] },
  { key: 'cricket',      label: 'Cricket',          cluster: 'sports',  terms: ['cricket','test match','odi','t20','wicket','batsman','bowler','ipl','innings'] },
  { key: 'football',     label: 'Football',         cluster: 'sports',  terms: ['football','premier league','goal','striker','fifa','world cup','uefa','soccer'] },
  { key: 'olympics',     label: 'Olympics',         cluster: 'sports',  terms: ['olympic','medal','athletics','commonwealth games','asian games'] },
  { key: 'tennis',       label: 'Tennis',           cluster: 'sports',  terms: ['tennis','wimbledon','grand slam','atp','wta'] },
  { key: 'chess',        label: 'Chess',            cluster: 'sports',  terms: ['chess','grandmaster','checkmate','candidates tournament'] },
  { key: 'motorsport',   label: 'Motorsport',       cluster: 'sports',  terms: ['formula 1','grand prix','motogp','racing driver'] },
  { key: 'movies',       label: 'Film',             cluster: 'culture', terms: ['film','movie','cinema','box office','director','bollywood','hollywood','oscar'] },
  { key: 'music',        label: 'Music',            cluster: 'culture', terms: ['music','album','song','concert','singer','band','grammy'] },
  { key: 'television',   label: 'Television',       cluster: 'culture', terms: ['tv series','television','episode','netflix','streaming show','documentary'] },
  // 'star' alone matched "forming stars" in astronomy copy — keep it qualified.
  { key: 'celebrity',    label: 'Celebrity',        cluster: 'culture', terms: ['actor','actress','celebrity','film star','pop star','superstar','red carpet','award show'] },
  { key: 'art',          label: 'Art & Design',     cluster: 'culture', terms: ['artist','painting','gallery','sculpture','exhibition','design award'] },
  { key: 'books',        label: 'Books',            cluster: 'culture', terms: ['book','author','novel','literature','poetry','publishing'] },
  { key: 'gaming',       label: 'Gaming',           cluster: 'culture', terms: ['video game','gaming','esports','console','playstation','xbox','nintendo'] },
  { key: 'schools',      label: 'Schools',          cluster: 'education',terms: ['school','student','teacher','classroom','curriculum','exam','syllabus','pupil'] },
  { key: 'universities', label: 'Universities',     cluster: 'education',terms: ['university','college','degree','campus','undergraduate','scholarship','admission'] },
  { key: 'transport',    label: 'Transport',        cluster: 'business',terms: ['railway','airline','flight','metro','highway','shipping','aviation'] },
  { key: 'agriculture',  label: 'Agriculture',      cluster: 'science', terms: ['farmer','agriculture','crop','harvest','monsoon','irrigation'] },
  { key: 'disasters',    label: 'Natural World',    cluster: 'science', terms: ['earthquake','cyclone','flood','volcano','drought','storm'] },
]);

const TOPIC_BY_KEY = new Map(TOPICS.map(t => [t.key, t]));
const CLUSTERS = ['science', 'tech', 'business', 'civic', 'sports', 'culture', 'health', 'education'];

// Civic topics are tracked as *engagement*, never as political alignment.
// These students are minors; the graph records how much current-affairs
// material they follow and how varied their sources are, both of which are
// teachable. It deliberately does not infer or store a political position.
const CIVIC_TOPICS = new Set(TOPICS.filter(t => t.cluster === 'civic').map(t => t.key));

// ── extraction ───────────────────────────────────────────────────────────────
function haystack(article) {
  return ` ${String(article?.title || '')} ${String(article?.summary || '')} `
    .toLowerCase().replace(/\s+/g, ' ');
}

// Word-boundary matchers, compiled once. Plain substring matching let short
// terms fire inside longer words ('ai' inside 'said', 'law' inside 'lawn').
// The right-side boundary matters too: without it, 'ai' also fires inside
// 'aircraft' — `(^|[^a-z])term(?![a-z])` requires the character before AND
// after the term to not be a lowercase letter.
const TOPIC_MATCHERS = TOPICS.map(topic => ({
  key: topic.key,
  cluster: topic.cluster,
  res: topic.terms.map(term => new RegExp(
    `(^|[^a-z])${term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i')),
}));

function extractTopics(article) {
  const text = haystack(article);
  const hits = [];
  for (const topic of TOPIC_MATCHERS) {
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
function articleVector(article) {
  const vec = Object.create(null);
  const genre = String(article?.category || '').toLowerCase();
  if (genre) vec[`g:${genre}`] = 1;
  for (const t of extractTopics(article)) {
    vec[`t:${t.key}`] = Math.min(1, 0.45 + t.score * 0.22);
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
});
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
 * Personalised ranking. Relevance is real but never total: a fixed exploration
 * term keeps unfamiliar genres reachable, otherwise the graph narrows onto
 * whatever the student clicked first and never widens again.
 */
function rankArticles(articles, studentVector, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const explore = options.explore ?? 0.18;
  const hasProfile = studentVector && Object.keys(studentVector).length > 0;

  const scored = articles.map(article => {
    const vec = articleVector(article);
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
 * `nodes`: [{ kind:'genre'|'topic'|'entity', key, weight }]
 */
function deriveAffinities(nodes) {
  const topics = nodes.filter(n => n.kind === 'topic' && n.weight > 0);
  const genres = nodes.filter(n => n.kind === 'genre' && n.weight > 0);
  const entities = nodes.filter(n => n.kind === 'entity' && n.weight > 0);
  const total = topics.reduce((s, n) => s + n.weight, 0) || 1;

  const byCluster = Object.fromEntries(CLUSTERS.map(c => [c, 0]));
  for (const n of topics) {
    const t = TOPIC_BY_KEY.get(n.key);
    if (t) byCluster[t.cluster] += n.weight;
  }
  const share = c => Number((byCluster[c] / total).toFixed(3));

  const civicWeight = topics
    .filter(n => CIVIC_TOPICS.has(n.key))
    .reduce((s, n) => s + n.weight, 0);

  return {
    topTopics: topics.sort((a, b) => b.weight - a.weight).slice(0, 8)
      .map(n => ({ key: n.key, label: TOPIC_BY_KEY.get(n.key)?.label || n.key, weight: Number(n.weight.toFixed(3)) })),
    topGenres: genres.sort((a, b) => b.weight - a.weight).slice(0, 5)
      .map(n => ({ key: n.key, label: GENRE_LABEL.get(n.key) || n.key, weight: Number(n.weight.toFixed(3)) })),
    topEntities: entities.sort((a, b) => b.weight - a.weight).slice(0, 8)
      .map(n => ({ key: n.key, weight: Number(n.weight.toFixed(3)) })),
    clusters: Object.fromEntries(CLUSTERS.map(c => [c, share(c)])),
    techAffinity:      share('tech'),
    scienceAffinity:   share('science'),
    sportsAffinity:    share('sports'),
    cultureAffinity:   share('culture'),   // film, music, celebrity, gaming, art
    businessAffinity:  share('business'),
    // Current-affairs engagement — a measure of attention, not of alignment.
    civicEngagement:   Number((civicWeight / total).toFixed(3)),
    // How spread the reading is across genres. Low means a narrow diet, which
    // is a media-literacy prompt for the teacher, not a judgement of the child.
    viewpointDiversity: Number(shannonEvenness(genres.map(n => n.weight)).toFixed(3)),
    signalStrength: Number(Math.min(1, total / 12).toFixed(3)),   // confidence
  };
}

/** Short block injected into the tutor prompt. */
function formatInterestsForPrompt(summary) {
  if (!summary || !summary.topTopics?.length) return '';
  if ((summary.signalStrength || 0) < 0.15) return '';   // too thin to act on
  const topics = summary.topTopics.slice(0, 5).map(t => t.label).join(', ');
  const lines = [`Real-world interests (from the student's own reading): ${topics}.`];
  if (summary.topEntities?.length) {
    lines.push(`Names they follow: ${summary.topEntities.slice(0, 4).map(e => e.key).join(', ')}.`);
  }
  const strong = Object.entries({
    technology: summary.techAffinity, science: summary.scienceAffinity,
    sport: summary.sportsAffinity, culture: summary.cultureAffinity,
    business: summary.businessAffinity, 'current affairs': summary.civicEngagement,
  }).filter(([, v]) => v >= 0.18).map(([k]) => k);
  if (strong.length) lines.push(`Leans towards: ${strong.join(', ')}.`);
  lines.push('Use these only to pick examples and analogies. Never change the academic content, difficulty, or correctness of an answer to match an interest.');
  return lines.join('\n');
}

module.exports = {
  GENRES, GENRE_KEYS, GENRE_LABEL, TOPICS, TOPIC_BY_KEY, CLUSTERS, CIVIC_TOPICS,
  SIGNAL_WEIGHTS, HALF_LIFE_DAYS,
  extractTopics, extractEntities, articleVector,
  decayFactor, signalWeight, cosine, recencyScore, rankArticles,
  shannonEvenness, deriveAffinities, formatInterestsForPrompt,
};
