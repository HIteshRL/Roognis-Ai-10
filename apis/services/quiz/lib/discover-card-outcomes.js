/**
 * Client for services/discover's card-attempt-outcomes route.
 *
 * Mirrors services/ai/discover-interest-context.js — this file is the entire
 * coupling from quiz back to Discover, and it only ever reads.
 *
 * This is the return leg of the ambient-revision loop: a student answers a
 * micro-recall question on an Academic Card in the Discover feed, and an
 * incorrect answer must count as evidence of a weak area here, the same as a
 * missed quiz/practice question does. Correct answers are deliberately not
 * returned — a weak-area aggregation counts misses, and feeding successes in
 * would silently turn it into an engagement signal, which the write layer
 * forbids (MASTERCONTEXT §7).
 *
 * TIMEOUT: 1500ms, deliberately shorter than this repo's DEFAULT_TIMEOUT_MS
 * of 4000 used by services/ai when it calls into quiz. This call is
 * nested inside a request that ai itself is timing out at 4000ms, so a slow
 * Discover must not push quiz's own latency into ai's timeout budget.
 *
 * FAILS SOFT, ALWAYS: any error, timeout, or malformed payload yields [], and
 * quiz's learning context is still returned without card evidence.
 * There is deliberately no `depends_on: discover` in the compose files —
 * Discover being down must never take quiz or practice with it.
 */
const CARD_OUTCOMES_TIMEOUT_MS = 1500;
const MAX_OUTCOMES = 20;
const MAX_DOCUMENT_IDS = 4;

/**
 * Labels originate in LLM-generated card content, so they are treated as
 * untrusted before they can reach a weak-area label (which is concatenated
 * into the tutor prompt downstream). Same filter both services already apply
 * in their own student-learning.js safeLabel().
 */
function safeCardLabel(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!cleaned) return null;
  if (/\b(?:ignore|disregard|system prompt|developer message|instruction|act as)\b/i.test(cleaned)) return null;
  return cleaned;
}

function asIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildCardOutcomesUrl(baseUrl, input = {}) {
  const params = new URLSearchParams({ studentId: String(input.studentId || '') });
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/discover/internal/card-attempt-outcomes?${params}`;
}

/**
 * Shape each outcome like a `rawArea` entry from an attempt's
 * `result.weakAreas`, so the aggregation loop in student-learning.js can
 * consume both without branching on where an entry came from.
 */
function normalizeCardOutcomes(payload = {}) {
  const raw = Array.isArray(payload?.outcomes) ? payload.outcomes : [];
  const normalized = [];

  for (const outcome of raw) {
    // Defence in depth: the route filters to incorrect attempts, but a
    // correct one arriving here must never be counted as a miss.
    if (outcome?.correct === true) continue;

    const label = safeCardLabel(outcome?.label);
    if (!label) continue;

    const documentIds = (Array.isArray(outcome?.documentIds) ? outcome.documentIds : [])
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim())
      .slice(0, MAX_DOCUMENT_IDS);

    normalized.push({
      label,
      conceptTag: safeCardLabel(outcome?.conceptTag),
      documentIds,
      answeredAt: asIsoDate(outcome?.answeredAt),
      sourceSurface: 'academic_card',
    });

    if (normalized.length >= MAX_OUTCOMES) break;
  }

  return normalized;
}

async function fetchCardOutcomes({
  studentId,
  baseUrl = process.env.DISCOVER_SERVICE_URL || 'http://discover:3008',
  token = process.env.INTERNAL_SERVICE_TOKEN,
  timeoutMs = CARD_OUTCOMES_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!studentId || !token) return [];

  try {
    const response = await fetchImpl(buildCardOutcomesUrl(baseUrl, { studentId }), {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-internal-service-token': token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeCardOutcomes(await response.json());
  } catch (err) {
    // Logged, not silent: "Discover is unreachable" must not be
    // indistinguishable from "this student has answered no cards".
    console.warn('[quiz] card attempt outcomes unavailable:', err.message);
    return [];
  }
}

module.exports = {
  CARD_OUTCOMES_TIMEOUT_MS,
  MAX_OUTCOMES,
  safeCardLabel,
  buildCardOutcomesUrl,
  normalizeCardOutcomes,
  fetchCardOutcomes,
};
