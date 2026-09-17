'use strict';
// Tavily search client.
//
// Chosen because it returns extracted page content in the same call as the
// ranked results, so the hunt needs no second scrape-and-parse hop — the thing
// that would otherwise turn a feature into a crawler. Everything provider-
// specific is confined to this file; the hunt only ever sees the normalised
// shape defined in ./provider.js.

const {
  SearchUnavailableError, normalizeSearchResult, clampMaxResults, DEFAULT_TIMEOUT_MS,
} = require('./provider');

const DEFAULT_BASE_URL = 'https://api.tavily.com';

function normalizeBaseUrl(value) {
  const base = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return base || DEFAULT_BASE_URL;
}

function createTavilyProvider({ apiKey, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('Tavily provider requires an API key.');
  const endpoint = `${normalizeBaseUrl(baseUrl)}/search`;

  async function search({ query, maxResults, freshnessDays = 14, signal } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: q,
          topic: 'news',
          search_depth: 'basic',
          days: Math.max(1, Math.min(30, Number(freshnessDays) || 14)),
          max_results: clampMaxResults(maxResults),
          // The generated answer is a synthesised summary across sources with
          // no single citable URL. Discover shows students real articles they
          // can open, so asking for it would only cost tokens.
          include_answer: false,
          include_raw_content: false,
          include_images: true,
        }),
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SearchUnavailableError(
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `Tavily search timed out after ${timeoutMs}ms`
          : `Tavily search failed: ${err.message}`,
        { provider: 'tavily' },
      );
    }

    if (!response.ok) {
      // The body can carry the account's billing state ("out of credits"). It
      // is useful in a log and must never reach a student, so callers surface
      // only a generic message — same discipline as the practice service's
      // provider-failure path.
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch { /* body already consumed or empty */ }
      throw new SearchUnavailableError(
        `Tavily search returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        { provider: 'tavily', status: response.status },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new SearchUnavailableError(`Tavily returned unparseable JSON: ${err.message}`, { provider: 'tavily' });
    }

    const rows = Array.isArray(payload?.results) ? payload.results : [];
    const images = Array.isArray(payload?.images) ? payload.images : [];

    return rows.map((row, index) => normalizeSearchResult({
      url: row?.url,
      title: row?.title,
      snippet: row?.content,
      content: row?.raw_content || row?.content,
      // Tavily's field name varies by plan/endpoint version; take whichever is
      // present and let parsePublishedDate reject anything unusable.
      publishedAt: row?.published_date || row?.publishedDate || null,
      // Images come back as a parallel top-level array, not per result. The
      // pairing is positional and therefore approximate — good enough for a
      // decorative card image, never used as evidence for anything.
      imageUrl: typeof images[index] === 'string' ? images[index] : images[index]?.url,
    })).filter(Boolean);
  }

  return { name: 'tavily', search };
}

module.exports = { createTavilyProvider, normalizeBaseUrl, DEFAULT_BASE_URL };
