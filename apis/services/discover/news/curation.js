'use strict';
// Article curation — safety gating, deduplication and category balancing.
//
// Ported from services/ai/student-news.js. This is the most valuable logic in
// the predecessor and it is deliberately provider-agnostic: it operates on a
// normalised candidate `{sourceKey, sourceName, category, title, summary, url,
// imageUrl, publishedAt}`, so the RSS fallback and the open-web hunt are gated
// by exactly the same rules. A hunt that reaches the wider internet must not be
// held to a *lower* standard than a curated BBC feed.

const BLOCKED_NEWS_TERMS = Object.freeze([
  'murder', 'murdered', 'killer', 'killing', 'killed', 'dead body', 'found dead',
  'shooting', 'shot dead', 'stabbing', 'stabbed', 'rape', 'raped', 'sexual assault',
  'suicide', 'self-harm', 'beheaded', 'beheading', 'corpse', 'massacre', 'bloodshed',
  'graphic footage', 'child abuse', 'domestic abuse', 'drug overdose', 'execution',
  'hostage', 'terror attack', 'bombing', 'fatal crash', 'dies after', 'death toll',
  'outbreak', 'earthquake', 'displaced', 'violence', 'violent', 'famine', 'humanitarian crisis',
  'jailed', 'theft', 'lawsuit', 'backlash', 'devastating', 'dire situation',
  ' dead ', ' died ', ' dies ', ' fatal ', 'scam', 'fraud', 'fake product',
  'nuclear weapon', 'nuclear weapons', 'nukes', 'weapon test',
  'accuses', 'hits out', 'undermine', 'clashes', 'threatens', 'threatened',
  'share price drops', 'stock market', 'wall street', 'losing out',
  'heatwave', 'pollution', 'poor water quality',
  'strikes', 'missiles', 'blockade', 'military targeted', 'fake',
  'atrocities', 'criminal court', 'schools closed', 'continues to worsen', 'cholera',
]);

const TECHNOLOGY_EDUCATIONAL_TERMS = Object.freeze([
  'technology', 'artificial intelligence', ' ai ', 'robot', 'computing', 'computer',
  'software', 'app', 'digital', 'internet', 'cyber', 'space', 'satellite', 'engineering',
  'energy', 'invention', 'innovation', 'research', 'scientist', 'students', 'game', 'chip',
]);

const WORLD_AFFAIRS_EDUCATIONAL_TERMS = Object.freeze([
  'agreement', 'cooperation', 'diplomacy', 'diplomatic', 'education', 'students', 'youth',
  'climate', 'environment', 'development', 'innovation', 'technology', 'science', 'space',
  'peace', 'peacekeepers', 'rebuild', 'recovery', 'aid', 'support', 'culture', 'heritage',
  'partnership', 'progress', 'scholarship', 'exchange programme', 'conservation',
  'renewable', 'protects', 'opens', 'launches', 'celebrates', 'achievement', 'record',
]);

const SCIENCE_POSITIVE_TERMS = Object.freeze([
  'discovery', 'discovers', 'discovered', 'research', 'study', 'scientist', 'science',
  'released', 'boost species', 'conservation', 'protect', 'restoration', 'recovery',
  'breakthrough', 'innovation', 'telescope', 'space', 'planet', 'moon', 'star', 'galaxy',
  'nature', 'wildlife', 'species', 'habitat', 'renewable', 'clean energy', 'recycling',
  'improves', 'successful', 'achievement', 'record', 'first time',
]);

// General-news genres carry the highest chance of distressing material, so
// they must earn inclusion by showing constructive/educational framing rather
// than merely avoiding blocked terms.
const GATED_GENERAL_GENRES = new Set(['world', 'india', 'top']);
const GATED_SCIENCE_GENRES = new Set(['science', 'environment', 'health']);
const OPEN_GENRES = new Set(['sports', 'entertainment', 'education', 'business', 'achievements']);

// Hunted articles land here. They pass the blocklist like everything else, but
// they are not made to prove "constructive framing": that gate exists because
// an untargeted world-news feed skews towards catastrophe, which is not true of
// a query the student's own interest graph asked for. Requiring cheerful
// wording on a rock-climbing or drone-regulation story would empty the lane.
const HUNT_GENRES = new Set(['interests']);

function includesNewsTerm(text, term) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return false;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index === 0 ? '' : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? '' : haystack[afterIndex];
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function isStudentSafeNews(candidate) {
  const combined = ` ${candidate?.title || ''} ${candidate?.summary || ''} `.toLowerCase();
  if (!combined.trim()) return false;
  if (BLOCKED_NEWS_TERMS.some(term => includesNewsTerm(combined, term))) return false;

  // Genre keys are lowercase. This used to compare against Title Case names and
  // ended in a whitelist — after the genre rename that whitelist would have
  // rejected every article and emptied the feed.
  const genre = String(candidate?.category || '').toLowerCase();

  if (HUNT_GENRES.has(genre)) return true;
  if (GATED_GENERAL_GENRES.has(genre)) {
    return WORLD_AFFAIRS_EDUCATIONAL_TERMS.some(term => includesNewsTerm(combined, term));
  }
  if (genre === 'technology') {
    return TECHNOLOGY_EDUCATIONAL_TERMS.some(term => includesNewsTerm(combined, term));
  }
  if (GATED_SCIENCE_GENRES.has(genre)) {
    return SCIENCE_POSITIVE_TERMS.some(term => includesNewsTerm(combined, term));
  }
  return OPEN_GENRES.has(genre);
}

const NEWS_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'says', 'that',
  'the', 'their', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'watch', 'live', 'update', 'updates', 'new', 'newly',
]);

function meaningfulTitleTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !NEWS_TITLE_STOP_WORDS.has(token));
}

function titleBigrams(tokens) {
  const bigrams = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

function areSimilarNewsStories(first, second) {
  if (!first || !second || first.category !== second.category) return false;
  const firstTokens = meaningfulTitleTokens(first.title);
  const secondTokens = meaningfulTitleTokens(second.title);
  if (firstTokens.length < 2 || secondTokens.length < 2) return false;

  const firstSet = new Set(firstTokens);
  const secondSet = new Set(secondTokens);
  const sharedTokens = [...firstSet].filter(token => secondSet.has(token));
  const smallerSetSize = Math.min(firstSet.size, secondSet.size);
  if (sharedTokens.length >= 3 && sharedTokens.length / smallerSetSize >= 0.45) return true;

  const firstBigrams = new Set(titleBigrams(firstTokens));
  return titleBigrams(secondTokens).some(bigram => firstBigrams.has(bigram));
}

function balanceNewsCategories(articles, limit = 15) {
  const preferredOrder = ['top', 'india', 'education', 'science', 'technology',
                          'business', 'health', 'world', 'sports', 'entertainment'];
  const buckets = new Map();
  articles.forEach(article => {
    const category = article.category || 'Other';
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(article);
  });
  const categories = [
    ...preferredOrder.filter(category => buckets.has(category)),
    ...[...buckets.keys()].filter(category => !preferredOrder.includes(category)).sort(),
  ];
  const selected = [];
  let round = 0;
  while (selected.length < limit) {
    // Take one article per category, but order each round by recency. Ranking
    // strictly by `preferredOrder` let a slow feed lead: BBC Technology can go
    // a day without publishing, so its top story was fronting the carousel
    // while two-hour-old stories sat behind it. Category balance is a property
    // of the selection, not of the order it is read in.
    const roundArticles = categories
      .map(category => buckets.get(category)?.[round])
      .filter(Boolean)
      .sort((a, b) => b.publishedAt - a.publishedAt);
    if (!roundArticles.length) break;
    for (const article of roundArticles) {
      selected.push(article);
      if (selected.length >= limit) break;
    }
    round += 1;
  }
  return selected;
}

function selectStudentNews(candidates, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeDays = Number(options.maxAgeDays || 10);
  const limit = Number(options.limit || 40);
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const uniqueStories = [];

  const eligible = candidates
    .filter(isStudentSafeNews)
    .filter(candidate => candidate.publishedAt.getTime() >= cutoff && candidate.publishedAt <= now)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter(candidate => {
      const key = canonicalArticleUrl(candidate.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      if (uniqueStories.some(article => areSimilarNewsStories(article, candidate))) return false;
      uniqueStories.push(candidate);
      return true;
    });
  return balanceNewsCategories(eligible, limit);
}

// ── shared text/url helpers ──────────────────────────────────────────────────
function stripHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function cleanText(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function normalizePublicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalArticleUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    ['at_medium', 'at_campaign', 'utm_source', 'utm_medium', 'utm_campaign'].forEach(key => url.searchParams.delete(key));
    return url.toString();
  } catch {
    return '';
  }
}

function parsePublishedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  BLOCKED_NEWS_TERMS, HUNT_GENRES, OPEN_GENRES,
  GATED_GENERAL_GENRES, GATED_SCIENCE_GENRES,
  includesNewsTerm, isStudentSafeNews,
  areSimilarNewsStories, meaningfulTitleTokens, titleBigrams,
  balanceNewsCategories, selectStudentNews,
  stripHtml, decodeXml, cleanText, normalizePublicUrl, canonicalArticleUrl, parsePublishedDate,
};
