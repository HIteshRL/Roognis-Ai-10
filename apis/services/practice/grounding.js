/**
 * Binding a practice set to the chapter the school actually uploaded.
 *
 * Duplicated from services/ai/visuals/grounding.js for the same reason
 * structured-llm.js is duplicated: services/practice is a standalone service
 * with no cross-service imports available. This module is lower-risk to
 * duplicate than the LLM seam — it's a thin, stable wrapper around one HTTP
 * call (GET /api/rag/internal/chapter-context) using the existing
 * INTERNAL_SERVICE_TOKEN pattern, the same way services/quiz already talks to
 * RAG independently of services/ai. That's the normal shape of a
 * microservices boundary, not the same kind of debt as the provider-selection
 * copy.
 *
 * Uses chapter-context, not RAG's /internal/retrieve — retrieve projects its
 * results down to { text, source, score } and throws away chunkId, chunkType
 * and the whole metadata block, which are exactly the fields citable practice
 * content needs.
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
 * of arbitrary blocks ("Reprint 2026-27"). Volume is not usefulness.
 */
const EXCLUDED_ENTITY_TYPES = new Set(['concept', 'canonicalconcept']);

/** Chunk types worth grounding a practice set on, best first. */
const PRACTICE_CHUNK_PREFERENCE = ['definition', 'passage', 'semantic', 'activity', 'question'];

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
  if (!ids.length) throw new Error('At least one documentId is required to ground a practice set.');

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

/**
 * Choose the chunks a practice set is built from.
 *
 * No topic text: generation is triggered by lesson identity alone (there is no
 * free-text student prompt in this flow), so this is a clean pedagogical-order
 * walk through the chapter, filtered to usable chunk types.
 */
function selectGroundingChunks(context, { limit = 24 } = {}) {
  const chunks = Array.isArray(context?.chunks) ? context.chunks : [];

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
      const preference = PRACTICE_CHUNK_PREFERENCE.indexOf(chunkType);
      return {
        chunk,
        preference: preference === -1 ? PRACTICE_CHUNK_PREFERENCE.length : preference,
        order: Number.isFinite(chunk.pedagogicalOrder) ? chunk.pedagogicalOrder : Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .sort((a, b) => (
      a.preference - b.preference
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
  PRACTICE_CHUNK_PREFERENCE,
  fetchChapterContext,
  selectGroundingChunks,
  chapterKeyFor,
  buildProvenance,
};
