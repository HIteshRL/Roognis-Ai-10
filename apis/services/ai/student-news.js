const { extractTopics, extractEntities } = require('./interest-graph');

// Ten genres so the feed can be browsed the way a real news app is browsed.
// `category` is the genre key the whole interest graph is indexed on — keep it
// lowercase and in sync with GENRES in interest-graph.js.
const DEFAULT_NEWS_FEEDS = Object.freeze([
  { key: 'bbc-top',           name: 'BBC News',  category: 'top',           url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { key: 'bbc-india',         name: 'BBC News',  category: 'india',         url: 'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml' },
  { key: 'bbc-business',      name: 'BBC News',  category: 'business',      url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { key: 'bbc-technology',    name: 'BBC News',  category: 'technology',    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { key: 'bbc-science',       name: 'BBC News',  category: 'science',       url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { key: 'bbc-health',        name: 'BBC News',  category: 'health',        url: 'https://feeds.bbci.co.uk/news/health/rss.xml' },
  // The UN News feed this replaced 404s at every published path.
  { key: 'bbc-education',     name: 'BBC News',  category: 'education',     url: 'https://feeds.bbci.co.uk/news/education/rss.xml' },
  { key: 'bbc-sport',         name: 'BBC Sport', category: 'sports',        url: 'https://feeds.bbci.co.uk/sport/rss.xml' },
  { key: 'bbc-entertainment', name: 'BBC News',  category: 'entertainment', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml' },
  { key: 'bbc-world',         name: 'BBC News',  category: 'world',         url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
]);

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

function parseRssFeed(xml, feed) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => normalizeRssItem(item, feed)).filter(Boolean);
}

function normalizeRssItem(item, feed) {
  const title = cleanText(readTag(item, 'title'), 220);
  const description = cleanText(stripHtml(readTag(item, 'description')), 420);
  const url = normalizePublicUrl(readTag(item, 'link'));
  const publishedAt = parsePublishedDate(readTag(item, 'pubDate'));
  if (!title || !url || !publishedAt) return null;

  return {
    sourceKey: feed.key,
    sourceName: feed.name,
    category: feed.category,
    title,
    summary: description || title,
    url,
    imageUrl: extractOriginalImageUrl(item),
    publishedAt,
  };
}

// General-news genres carry the highest chance of distressing material, so
// they must earn inclusion by showing constructive/educational framing rather
// than merely avoiding blocked terms.
const GATED_GENERAL_GENRES = new Set(['world', 'india', 'top']);
const GATED_SCIENCE_GENRES = new Set(['science', 'environment', 'health']);
const OPEN_GENRES = new Set(['sports', 'entertainment', 'education', 'business', 'achievements']);

function isStudentSafeNews(candidate) {
  const combined = ` ${candidate?.title || ''} ${candidate?.summary || ''} `.toLowerCase();
  if (!combined.trim()) return false;
  if (BLOCKED_NEWS_TERMS.some(term => includesNewsTerm(combined, term))) return false;

  // Genre keys are lowercase. This used to compare against Title Case names and
  // ended in a whitelist — after the genre rename that whitelist would have
  // rejected every article and emptied the feed.
  const genre = String(candidate?.category || '').toLowerCase();

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

const NEWS_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'says', 'that',
  'the', 'their', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'watch', 'live', 'update', 'updates', 'new', 'newly',
]);

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

// selectionLimit: ten genres need a far bigger retained pool than the old five
// did, otherwise personalised ranking has almost nothing to choose between.
async function refreshStudentNews({
  prisma, fetchImpl = fetch, feeds = DEFAULT_NEWS_FEEDS,
  now = new Date(), selectionLimit = 220,
}) {
  const settled = await Promise.allSettled(feeds.map(async feed => {
    const response = await fetchImpl(feed.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'RoognisStudentNews/1.0 (+educational dashboard)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${feed.name} feed returned HTTP ${response.status}`);
    return parseRssFeed(await response.text(), feed);
  }));

  const candidates = [];
  const errors = [];
  const successfulFeedKeys = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
      successfulFeedKeys.push(feeds[index].key);
    }
    else errors.push(`${feeds[index].name}: ${result.reason?.message || 'feed unavailable'}`);
  });

  const selected = selectStudentNews(candidates, { now, limit: selectionLimit });
  const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
  for (const article of selected) {
    // Extract facets once, here. Ranking runs on every feed request and must
    // never re-parse article text.
    const topics = extractTopics(article).map(topic => topic.key);
    const entities = extractEntities(article).map(entity => entity.key);
    await prisma.studentNewsArticle.upsert({
      where: { url: article.url },
      create: {
        ...article,
        topics,
        entities,
        safetyStatus: 'approved',
        expiresAt,
      },
      update: {
        sourceKey: article.sourceKey,
        sourceName: article.sourceName,
        category: article.category,
        title: article.title,
        summary: article.summary,
        imageUrl: article.imageUrl,
        publishedAt: article.publishedAt,
        topics,
        entities,
        safetyStatus: 'approved',
        expiresAt,
      },
    });
  }

  if (successfulFeedKeys.length) {
    await prisma.studentNewsArticle.deleteMany({
      where: {
        sourceKey: { in: successfulFeedKeys },
        ...(selected.length ? { url: { notIn: selected.map(article => article.url) } } : {}),
      },
    });
  }

  await prisma.studentNewsArticle.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  return { fetched: candidates.length, approved: selected.length, errors };
}

function readTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function extractOriginalImageUrl(item) {
  const patterns = [
    /<media:thumbnail\b[^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[a-z0-9.+-]+["'][^>]*>/i,
    /<enclosure\b[^>]*\btype=["']image\/[a-z0-9.+-]+["'][^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = String(item || '').match(pattern);
    const url = normalizePublicUrl(decodeXml(match?.[1] || ''));
    if (url) return url;
  }
  return null;
}

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
  DEFAULT_NEWS_FEEDS,
  BLOCKED_NEWS_TERMS,
  parseRssFeed,
  isStudentSafeNews,
  selectStudentNews,
  balanceNewsCategories,
  areSimilarNewsStories,
  refreshStudentNews,
  extractOriginalImageUrl,
};
