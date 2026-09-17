'use strict';
// Open-vocabulary interest topics.
//
// The predecessor (services/ai/interest-graph.js) froze 41 curated topics into
// an array at module load. That made the taxonomy safe and testable but closed:
// a student reading about rock climbing, FPV drones or resin printing produced
// zero topic nodes, because those concepts had no representation at all. This
// module keeps the curated 41 as seeds and lets the vocabulary grow at runtime.
//
// The growth path is the part that has to stay honest. A model may propose a
// *label* ("Rock climbing"). It never chooses the key, the cluster mapping, or
// the match terms — `canonicalKey()` and `topicFromLabel()` below are pure
// functions of the label text and a static alias table, so the same label
// always yields the same key on every machine, with or without an API key.

const CLUSTERS = ['science', 'tech', 'business', 'civic', 'sports', 'culture', 'health', 'education'];
const DEFAULT_CLUSTER = 'other';
const ALL_CLUSTERS = [...CLUSTERS, DEFAULT_CLUSTER];

const MAX_KEY_LENGTH = 90;
const MAX_LABEL_LENGTH = 120;

// ── the curated seeds ────────────────────────────────────────────────────────
// Ported verbatim from services/ai/interest-graph.js. Keys must not change:
// they are what the one-time legacy-graph import maps onto, so renaming one
// would silently orphan every existing student's node.
const SEED_TOPICS = Object.freeze([
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

// Civic topics are tracked as *engagement*, never as political alignment.
// These students are minors; the graph records how much current-affairs
// material they follow and how varied their sources are, both of which are
// teachable. It deliberately does not infer or store a political position.
const CIVIC_SEED_KEYS = new Set(SEED_TOPICS.filter(t => t.cluster === 'civic').map(t => t.key));

// ── canonicalisation ─────────────────────────────────────────────────────────
// Synonyms that must collapse onto one key. Two jobs: keep the long tail from
// fragmenting ("drone"/"drones"/"uav" are one interest, not three), and pin the
// seed keys so the generic singulariser below can never rewrite them — those
// keys already exist in every student's imported graph.
const ALIASES = new Map(Object.entries({
  // identity pins for seed keys whose plural form would otherwise be stripped
  sports: 'sports', markets: 'markets', jobs: 'jobs', schools: 'schools',
  universities: 'universities', books: 'books', movies: 'movies',
  disasters: 'disasters', elections: 'elections', startups: 'startups',
  olympics: 'olympics', physics: 'physics', maths: 'maths', mathematics: 'maths',
  // hobby / specialist tail — the interests the closed taxonomy could not hold
  '3d-printer': '3d-printing', '3d-print': '3d-printing', '3d-prints': '3d-printing',
  'additive-manufacturing': '3d-printing', 'fdm': '3d-printing', 'resin-printing': '3d-printing',
  'drone': 'drones', 'uav': 'drones', 'fpv-drone': 'drones', 'fpv-drones': 'drones',
  'quadcopter': 'drones', 'quadcopters': 'drones', 'drone-racing': 'drones',
  'defence-technology': 'defence-tech', 'defense-technology': 'defence-tech',
  'defense-tech': 'defence-tech', 'military-technology': 'defence-tech',
  'climbing': 'rock-climbing', 'bouldering': 'rock-climbing', 'sport-climbing': 'rock-climbing',
  'dancing': 'dance', 'dancer': 'dance',
  'robot': 'robotics', 'robots': 'robotics',
  'photograph': 'photography', 'photographs': 'photography', 'photographer': 'photography',
  'cooking': 'cooking', 'baking': 'cooking', 'cookery': 'cooking',
  'skateboard': 'skateboarding', 'skating': 'skateboarding',
  'cycle': 'cycling', 'bicycle': 'cycling', 'biking': 'cycling',
  'astro': 'space', 'astronomy': 'space', 'spaceflight': 'space', 'isro': 'space',
  'artificial-intelligence': 'ai', 'machine-learning': 'ai', 'llm': 'ai', 'llms': 'ai',
  'videogame': 'gaming', 'videogames': 'gaming', 'video-game': 'gaming',
  'video-games': 'gaming', 'esports': 'gaming', 'e-sports': 'gaming',
}));

const DIACRITIC_RE = /[̀-ͯ]/g;

/**
 * Strip a plural, conservatively. Only reached for labels the alias table does
 * not already pin, so it can never rewrite a seed key.
 */
function singularise(word) {
  if (word.length <= 3) return word;
  if (/(ss|us|is|ics|ies|s's)$/.test(word)) {
    return word.endsWith('ies') ? `${word.slice(0, -3)}y` : word;
  }
  if (/(ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Label -> stable slug. Pure: same input, same output, everywhere, forever.
 * This is the function that keeps MASTERCONTEXT §7 intact — a model can suggest
 * what to call an interest, but only this decides what it *is*.
 */
function canonicalKey(label) {
  const base = String(label || '')
    .normalize('NFD').replace(DIACRITIC_RE, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_LENGTH)
    .replace(/-+$/g, '');
  if (!base) return '';
  if (ALIASES.has(base)) return ALIASES.get(base);

  const parts = base.split('-');
  const singular = [...parts.slice(0, -1), singularise(parts[parts.length - 1])]
    .filter(Boolean).join('-');
  return ALIASES.get(singular) || singular || base;
}

/**
 * Resolve the key a label should use against a live vocabulary, catching the
 * gap canonicalKey() alone cannot: it only merges synonyms someone already
 * added to ALIASES, so a model-proposed label like "Quadcopter racing" mints
 * a brand-new key even though the existing "drones" topic's terms already
 * match it. This only ever runs on the path that would otherwise create a
 * new key — an already-known key is returned unchanged, so behaviour for the
 * common case is byte-identical to a bare canonicalKey() call.
 *
 * Ambiguous (multiple existing topics match) or zero matches fall through to
 * minting a new key, same as today — this never guesses.
 */
function resolveTopicKey(label, vocab) {
  const key = canonicalKey(label);
  if (!key || !vocab || vocab.has(key)) return key;

  const text = ` ${cleanLabel(label).toLowerCase()} `;
  const matched = new Set();
  for (const matcher of vocab.matchers()) {
    if (matcher.res.some(re => re.test(text))) matched.add(matcher.key);
  }
  return matched.size === 1 ? [...matched][0] : key;
}

function normaliseCluster(cluster) {
  const value = String(cluster || '').trim().toLowerCase();
  return ALL_CLUSTERS.includes(value) ? value : DEFAULT_CLUSTER;
}

function cleanLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Build a topic record from a free-text label. Match terms are derived from the
 * label plus every alias that points at the resulting key, so a newly created
 * "drones" topic immediately matches "quadcopter" and "UAV" copy without anyone
 * hand-writing a term list.
 */
function topicFromLabel(label, cluster) {
  const key = canonicalKey(label);
  if (!key) return null;

  const terms = new Set();
  const spaced = key.replace(/-/g, ' ');
  terms.add(spaced);
  const cleaned = cleanLabel(label).toLowerCase();
  if (cleaned) terms.add(cleaned);
  for (const [alias, target] of ALIASES) {
    if (target === key) terms.add(alias.replace(/-/g, ' '));
  }

  return {
    key,
    label: cleanLabel(label) || spaced.replace(/\b\w/g, c => c.toUpperCase()),
    cluster: normaliseCluster(cluster),
    terms: [...terms].filter(t => t.length >= 3).slice(0, 24),
  };
}

// ── the runtime vocabulary ───────────────────────────────────────────────────
function escapeTerm(term) {
  return String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matchers. Plain substring matching let short terms fire inside
// longer words ('ai' inside 'said', 'law' inside 'lawn'). The right-side
// boundary matters too: without it, 'ai' also fires inside 'aircraft' —
// `(^|[^a-z])term(?![a-z])` requires the character before AND after the term
// to not be a lowercase letter.
function compileMatcher(topic) {
  return {
    key: topic.key,
    cluster: topic.cluster,
    res: (topic.terms || [])
      .map(term => escapeTerm(term))
      .filter(Boolean)
      .map(term => new RegExp(`(^|[^a-z])${term}(?![a-z])`, 'i')),
  };
}

/**
 * A vocabulary is a mutable set of topics plus their compiled matchers. It is
 * created per process from the DB (seeds + everything grown since) and topped
 * up in place when a new topic is promoted, so a single request never pays to
 * recompile the whole table.
 */
function createVocabulary(topics = SEED_TOPICS) {
  const byKey = new Map();
  const matchers = [];

  function add(topic) {
    if (!topic || !topic.key) return null;
    const record = {
      key: topic.key,
      label: cleanLabel(topic.label) || topic.key,
      cluster: normaliseCluster(topic.cluster),
      terms: Array.isArray(topic.terms) ? topic.terms : [],
      status: topic.status === 'blocked' ? 'blocked' : 'active',
    };
    const existing = byKey.get(record.key);
    byKey.set(record.key, record);
    if (existing) {
      const index = matchers.findIndex(m => m.key === record.key);
      if (index >= 0) matchers.splice(index, 1);
    }
    if (record.status === 'active') matchers.push(compileMatcher(record));
    return record;
  }

  for (const topic of topics) add(topic);

  return {
    add,
    has: key => byKey.has(key),
    get: key => byKey.get(key),
    size: () => byKey.size,
    all: () => [...byKey.values()],
    matchers: () => matchers,
    labelOf: key => byKey.get(key)?.label || key,
    clusterOf: key => byKey.get(key)?.cluster || DEFAULT_CLUSTER,
    isCivic: key => byKey.get(key)?.cluster === 'civic',
  };
}

module.exports = {
  CLUSTERS, ALL_CLUSTERS, DEFAULT_CLUSTER, SEED_TOPICS, CIVIC_SEED_KEYS, ALIASES,
  MAX_KEY_LENGTH, MAX_LABEL_LENGTH,
  canonicalKey, resolveTopicKey, singularise, normaliseCluster, cleanLabel, topicFromLabel,
  createVocabulary,
};
