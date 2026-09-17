'use strict';
// YouTube Data API v3 client for the video hunt.
//
// A documented SUPERSET of the search/provider.js interface, not a strict
// match: `search({query, maxResults, freshnessDays})` returns the same core
// fields (url, title, snippet, publishedAt, sourceName, imageUrl) plus
// videoId/channelId/channelName, which the niche-scoring formula needs as
// first-class inputs (video/scoring.js), not something re-parsed out of
// `content`. Anything that only wants the narrow shape still works.
//
// Deliberately does NOT set videoCategoryId:'27' (Education) the way
// services/ai/server.js's tutor-chat video search does — a niche geopolitics
// analyst is not filed under YouTube's Education category, and that filter
// alone would defeat this feature's entire goal.
//
// Near-duplicates services/ai/server.js's existing YouTube REST calls
// (raw fetch(), no SDK). Accepted explicitly, same posture as this repo's
// existing 6x structured-llm.js duplication — no cross-service imports exist
// anywhere in this codebase, so a separate deployable cannot require() the ai
// copy. Recorded in HANDOFF.md.

const { validateGeneratedTextSafety } = require('../safety');
const { cleanText, normalizePublicUrl } = require('../news/curation');

const DEFAULT_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESULTS = 8;
const BATCH_SIZE = 50; // videos.list / channels.list accept up to 50 ids per call

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseYoutubeDuration(duration) {
  if (typeof duration !== 'string') return 0;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function fetchJsonWithTimeout(fetchImpl, url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`YouTube API HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A search result is untrusted third-party text, exactly like a web-search
 * hit. Same gate as isUsableYoutubeSearchItem in services/ai/server.js, plus
 * a channel-name check that file does not have — a channel name is exactly
 * as attacker-controllable as a video title.
 */
function isUsableSearchItem(item) {
  const videoId = item?.id?.videoId;
  const snippet = item?.snippet;
  if (!videoId || !snippet?.title || !snippet?.channelTitle) return false;
  const titleSafety = validateGeneratedTextSafety(decodeHtmlEntities(snippet.title));
  const descriptionSafety = validateGeneratedTextSafety(decodeHtmlEntities(snippet.description || ''));
  const channelSafety = validateGeneratedTextSafety(decodeHtmlEntities(snippet.channelTitle));
  return titleSafety.allowed && descriptionSafety.allowed && channelSafety.allowed;
}

function toSearchResult(item) {
  const videoId = item?.id?.videoId;
  const snippet = item?.snippet;
  if (!videoId || !snippet) return null;
  const url = normalizePublicUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const title = cleanText(decodeHtmlEntities(snippet.title), 220);
  if (!url || !title) return null;
  return {
    url,
    title,
    snippet: cleanText(decodeHtmlEntities(snippet.description || ''), 420),
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
    sourceName: cleanText(decodeHtmlEntities(snippet.channelTitle), 160) || 'YouTube',
    imageUrl: normalizePublicUrl(snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url),
    videoId,
    channelId: snippet.channelId || null,
    channelName: cleanText(decodeHtmlEntities(snippet.channelTitle), 160),
  };
}

function createYoutubeProvider({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('YouTube provider requires an API key.');
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

  async function search({ query, maxResults = DEFAULT_MAX_RESULTS, signal } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    const params = new URLSearchParams({
      part: 'snippet',
      q,
      type: 'video',
      maxResults: String(Math.max(1, Math.min(25, Number(maxResults) || DEFAULT_MAX_RESULTS))),
      safeSearch: 'strict',
      relevanceLanguage: 'en',
      order: 'relevance',
      key: apiKey,
    });

    let result;
    try {
      result = await fetchJsonWithTimeout(fetchImpl, `${base}/search?${params.toString()}`, { timeoutMs });
    } catch (err) {
      if (signal?.aborted) return [];
      throw new Error(`YouTube search failed: ${err.message}`);
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    return items.filter(isUsableSearchItem).map(toSearchResult).filter(Boolean);
  }

  /** videos.list — duration/view-count/embeddable. 1 unit/call, batches 50 ids. */
  async function loadVideoDetails(videoIds) {
    const uniqueIds = [...new Set((videoIds || []).filter(Boolean))];
    const detailById = new Map();
    for (const batch of chunk(uniqueIds, BATCH_SIZE)) {
      const params = new URLSearchParams({
        part: 'contentDetails,statistics,status',
        id: batch.join(','),
        key: apiKey,
      });
      const result = await fetchJsonWithTimeout(fetchImpl, `${base}/videos?${params.toString()}`, { timeoutMs });
      for (const item of result?.items || []) {
        if (!item?.id) continue;
        if (item.status?.embeddable === false) continue;
        detailById.set(item.id, {
          durationSeconds: parseYoutubeDuration(item.contentDetails?.duration),
          viewCount: Number(item.statistics?.viewCount || 0),
        });
      }
    }
    return detailById;
  }

  /** channels.list — subscriber/video counts + uploads playlist id. 1 unit/call, batches 50. */
  async function loadChannelDetails(channelIds) {
    const uniqueIds = [...new Set((channelIds || []).filter(Boolean))];
    const detailById = new Map();
    for (const batch of chunk(uniqueIds, BATCH_SIZE)) {
      const params = new URLSearchParams({
        part: 'statistics,contentDetails',
        id: batch.join(','),
        key: apiKey,
      });
      const result = await fetchJsonWithTimeout(fetchImpl, `${base}/channels?${params.toString()}`, { timeoutMs });
      for (const item of result?.items || []) {
        if (!item?.id) continue;
        detailById.set(item.id, {
          subscriberCount: item.statistics?.hiddenSubscriberCount ? null : Number(item.statistics?.subscriberCount || 0),
          videoCount: Number(item.statistics?.videoCount || 0),
          uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
        });
      }
    }
    return detailById;
  }

  /**
   * playlistItems.list — a channel's recent upload titles, for the
   * topicNarrowness sample. 1 unit/call. Cannot batch across channels, unlike
   * the two calls above — one call per channel is the real per-channel
   * enrichment cost, which is why hunt/video-run.js budgets it separately.
   */
  async function loadRecentUploadTitles(uploadsPlaylistId, { limit = 20 } = {}) {
    if (!uploadsPlaylistId) return [];
    const params = new URLSearchParams({
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.max(1, Math.min(50, Number(limit) || 20))),
      key: apiKey,
    });
    let result;
    try {
      result = await fetchJsonWithTimeout(fetchImpl, `${base}/playlistItems?${params.toString()}`, { timeoutMs });
    } catch {
      return []; // enrichment is a bonus, never a hard requirement — see hunt/video-run.js
    }
    return (result?.items || [])
      .map(item => decodeHtmlEntities(item?.snippet?.title || ''))
      .filter(Boolean);
  }

  return { name: 'youtube', search, loadVideoDetails, loadChannelDetails, loadRecentUploadTitles };
}

/**
 * Fail-closed, same posture as resolveSearchProvider: no key → null → the
 * video hunt tick no-ops entirely, never a broken/degraded state.
 */
function resolveVideoSearchProvider(env = process.env) {
  if (!env.YOUTUBE_API_KEY) return null;
  return createYoutubeProvider({
    apiKey: env.YOUTUBE_API_KEY,
    baseUrl: env.YOUTUBE_API_BASE_URL,
    timeoutMs: Number(env.DISCOVER_VIDEO_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  });
}

module.exports = {
  DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESULTS,
  createYoutubeProvider, resolveVideoSearchProvider,
  parseYoutubeDuration, decodeHtmlEntities, isUsableSearchItem, toSearchResult,
};
