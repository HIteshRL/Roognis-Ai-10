/**
 * Binding a visual to the chapter the school actually uploaded.
 *
 * Uses GET /api/rag/internal/chapter-context, not the /internal/retrieve call
 * that `retrieveRagChunks` in server.js makes. Retrieve projects its results
 * down to { text, source, score } and throws away chunkId, chunkType and the
 * whole metadata block — which are exactly the fields a citable visual needs.
 * Request shape is copied from `fetchRagChapterContext` in
 * services/quiz/lib/generation.js, which already grounds against this endpoint.
 */
const crypto = require('node:crypto');

const DEFAULT_RAG_URL = 'http://rag:3003';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CHUNKS = 80;

/**
 * Entity types excluded from grounding.
 *
 * `Concept` is the classifier's fallback branch and every heading becomes one
 * too, so a large ingested textbook corpus produced 2680 entities
 * against 58 Definitions and 87 Questions — and their titles are `first_phrase()`
 * of arbitrary blocks ("Reprint 2026-27"). Volume is not usefulness. The demo
 * seeder reached the same conclusion independently; see the rationale comment
 * and ANCHOR_PRECEDENCE in seed-data/demo-history/lib/chapter-qa.js.
 */
const EXCLUDED_ENTITY_TYPES = new Set(['concept', 'canonicalconcept']);

/** Chunk types worth grounding a concept map on, best first. */
const CONCEPT_MAP_CHUNK_PREFERENCE = ['definition', 'passage', 'semantic', 'activity', 'question'];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'from',
  'about', 'how', 'what', 'why', 'is', 'are', 'this', 'that', 'these', 'those',
]);

function trimSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function fetchJson(url, options, timeoutMs, fetchFn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (fetchFn || fetch)(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`RAG chapter context failed with ${response.status}: ${body}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch chapter context by documentId.
 *
 * documentIds only. The client knows a document id (it is already the lesson
 * key in the frontend) but holds just 6 of the 9 fields in the chapter identity
 * tuple, so it cannot address a chapter the other way and must not try — the
 * server derives the full identity from what RAG returns.
 */
async function fetchChapterContext({ documentIds, maxChunks = DEFAULT_MAX_CHUNKS }, options = {}) {
  const ids = (Array.isArray(documentIds) ? documentIds : [documentIds]).filter(Boolean);
  if (!ids.length) throw new Error('At least one documentId is required to ground a visual.');

  const ragUrl = options.ragServiceUrl || process.env.RAG_SERVICE_URL || DEFAULT_RAG_URL;
  const token = options.internalServiceToken || process.env.INTERNAL_SERVICE_TOKEN || '';
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required to fetch RAG chapter context.');

  const params = new URLSearchParams({
    documentIds: ids.join(','),
    maxChunks: String(maxChunks),
  });

  return fetchJson(
    `${trimSlashes(ragUrl)}/api/rag/internal/chapter-context?${params.toString()}`,
    { method: 'GET', headers: { 'X-Internal-Service-Token': token } },
    options.ragTimeoutMs || DEFAULT_TIMEOUT_MS,
    options.fetchFn
  );
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Tokenizer for cache-key derivation only. tokenize()'s length > 2 filter is
 * fine for ranking noise reduction but drops short-but-meaningful science
 * terms (element symbols, units: "Na", "K", "pH") — which previously made
 * "role of Na in nerve conduction" and "role of K in nerve conduction" hash
 * to the identical conceptSlug and silently served one topic's cached
 * diagram for the other. Precision matters more than noise reduction here.
 */
function tokenizeForCacheKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 0 && !STOPWORDS.has(word));
}

/**
 * Score a chunk against the requested topic by token overlap.
 *
 * Deliberately lexical. This picks which source text the renderer is grounded
 * on, and that is a selection step — it stays deterministic and inspectable
 * rather than becoming an embedding call whose result cannot be reproduced.
 */
function overlapScore(chunkText, topicTokens) {
  if (!topicTokens.length) return 0;
  const chunkTokens = new Set(tokenize(chunkText));
  if (!chunkTokens.size) return 0;
  let hits = 0;
  for (const token of topicTokens) {
    if (chunkTokens.has(token)) hits += 1;
  }
  return hits / topicTokens.length;
}

/**
 * Choose the chunks a visual is built from.
 *
 * Ordering is: topic overlap first (so a request about one part of a chapter
 * lands there), then chunk-type preference, then the chapter's own pedagogical
 * order. With no topic text the overlap term is zero everywhere and the result
 * is a clean pedagogical-order walk through the chapter.
 */
function selectGroundingChunks(context, { topicText = '', limit = 18 } = {}) {
  const chunks = Array.isArray(context?.chunks) ? context.chunks : [];
  const topicTokens = tokenize(topicText);

  const usable = chunks.filter(chunk => {
    const entityType = String(chunk?.metadata?.entityType || '').toLowerCase();
    if (EXCLUDED_ENTITY_TYPES.has(entityType)) return false;
    const text = typeof chunk?.text === 'string' ? chunk.text.trim() : '';
    // Entity chunks average ~38 characters and are frequently a bare fragment
    // ("parliamentary system, and"). Too short to build a claim on.
    return text.length >= 80 && Boolean(chunk.chunkId);
  });

  const ranked = usable
    .map((chunk, index) => {
      const chunkType = String(chunk.chunkType || '').toLowerCase();
      const preference = CONCEPT_MAP_CHUNK_PREFERENCE.indexOf(chunkType);
      return {
        chunk,
        overlap: overlapScore(chunk.text, topicTokens),
        preference: preference === -1 ? CONCEPT_MAP_CHUNK_PREFERENCE.length : preference,
        order: Number.isFinite(chunk.pedagogicalOrder) ? chunk.pedagogicalOrder : Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .sort((a, b) => (
      b.overlap - a.overlap
      || a.preference - b.preference
      || a.order - b.order
      || a.index - b.index
    ));

  return ranked.slice(0, limit).map(entry => entry.chunk);
}

/**
 * Stable identity for a chapter, from RAG's own 9-tuple.
 *
 * Same tuple RAG groups documents by (`chapter_identity_key`), hashed so it fits
 * a VarChar(80) and can be indexed. Casefolded because the tuple's text fields
 * arrive with inconsistent casing across uploads.
 */
function chapterKeyFor(chapter) {
  if (!chapter || typeof chapter !== 'object') {
    throw new Error('A chapter summary is required to derive a chapter key.');
  }
  const tuple = [
    chapter.schoolId, chapter.board, chapter.curriculum, chapter.grade,
    chapter.subject, chapter.book, chapter.chapterNumber, chapter.language, chapter.edition,
  ].map(part => String(part ?? '').trim().toLowerCase()).join('|');

  return crypto.createHash('sha256').update(tuple).digest('hex').slice(0, 64);
}

/**
 * Stable cache identity for what the student asked about.
 *
 * Derived from the resolved grounding, never from model output. If an LLM
 * normalised the prompt into a slug, the same request could produce two slugs
 * on two runs, and therefore two artifacts and two cache misses — a
 * non-deterministic cache key is not a cache.
 *
 * Prefers the entity the request resolved to. Falls back to a hash of the
 * sorted, stopword-stripped prompt tokens, so "how do cells divide" and
 * "cells divide how" are one key.
 */
function conceptSlugFor(topicText, resolvedEntityId) {
  if (resolvedEntityId) {
    return `e:${String(resolvedEntityId).trim().toLowerCase()}`.slice(0, 120);
  }
  const tokens = tokenizeForCacheKey(topicText).sort();
  if (!tokens.length) return 'chapter';
  return `t:${crypto.createHash('sha256').update(tokens.join(' ')).digest('hex').slice(0, 32)}`;
}

/** Trim a chunk list into the citation payload the client renders as provenance. */
function buildProvenance(chapter, chunks) {
  return {
    subject: chapter?.subject || null,
    grade: chapter?.grade ?? null,
    chapterNumber: chapter?.chapterNumber ?? null,
    chapterName: chapter?.chapterName || null,
    excerpts: chunks.slice(0, 4).map((chunk, index) => ({
      index: index + 1,
      text: String(chunk.text || '').slice(0, 320),
      source: chunk.source || 'Lesson',
    })),
  };
}

module.exports = {
  EXCLUDED_ENTITY_TYPES,
  CONCEPT_MAP_CHUNK_PREFERENCE,
  fetchChapterContext,
  selectGroundingChunks,
  chapterKeyFor,
  conceptSlugFor,
  buildProvenance,
  tokenize,
};
