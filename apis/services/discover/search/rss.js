'use strict';
// RSS reader — the zero-key fallback path.
//
// Ported from services/ai/student-news.js, where it was the *only* source. Here
// it is the floor: with no TAVILY_API_KEY the stack still boots, the feed is
// still populated and the genre tabs still work; only the interest-targeted
// hunt lane is missing. Same reasoning as video-search.js degrading to its
// curated topic list — a missing third-party key must never mean a blank app.
//
// The parser is regex over <item> blocks rather than a real XML parser. That is
// inherited, and it is fine for the handful of well-formed publisher feeds
// below; do not point it at arbitrary user-supplied XML.

const {
  cleanText, stripHtml, decodeXml, normalizePublicUrl, parsePublishedDate,
} = require('../news/curation');

// `category` is the genre key the whole interest graph is indexed on — keep it
// lowercase and in sync with GENRES in interest/graph.js.
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

function readTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

// BBC's ichef image proxy encodes the requested rendition width as a literal
// path segment (…/ace/standard/240/…). Every feed's <media:thumbnail> points
// at the 240px rendition — sized for the old RSS-reader thumbnail, not for a
// card whose cover image renders up to 680px wide on a retina display. This
// substitutes a larger step of the *same* crop from the *same* asset on the
// *same* already-trusted domain — not a new fetch target, just a different
// rendition of one BBC already approved. 976px is one of ichef's standard
// width steps and covers the feed's card sizes at up to ~2x device pixel
// ratio without pulling a needlessly large asset for a thumbnail-scale slot.
function upsizeIchefImage(url) {
  if (!url) return url;
  return url.replace(/(ichef\.bbci\.co\.uk\/ace\/[a-z_]+)\/\d+\//i, '$1/976/');
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
    if (url) return upsizeIchefImage(url);
  }
  return null;
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

function parseRssFeed(xml, feed) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => normalizeRssItem(item, feed)).filter(Boolean);
}

/**
 * Fetch every configured feed. Partial success is the normal case — one
 * publisher 503ing must not empty the whole feed, so failures are collected
 * and returned rather than thrown, and the caller only reconciles the
 * categories whose feed actually answered.
 */
async function fetchRssCandidates({ feeds = DEFAULT_NEWS_FEEDS, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const settled = await Promise.allSettled(feeds.map(async feed => {
    const response = await fetchImpl(feed.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'RoognisDiscover/1.0 (+educational dashboard)',
      },
      signal: AbortSignal.timeout(timeoutMs),
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
    } else {
      errors.push(`${feeds[index].name}: ${result.reason?.message || 'feed unavailable'}`);
    }
  });

  return { candidates, errors, successfulFeedKeys };
}

module.exports = {
  DEFAULT_NEWS_FEEDS,
  readTag, extractOriginalImageUrl, normalizeRssItem, parseRssFeed, fetchRssCandidates,
};
