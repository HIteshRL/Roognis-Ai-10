/**
 * Client for services/discover's interest-context route — mirrors
 * practice-learning-context.js exactly.
 *
 * The interest graph used to live in this service (interest-graph.js /
 * interest-store.js, reading ai_db). It now lives in services/discover, which
 * owns the whole Discover surface, so the tutor reads it over the internal API
 * instead of out of its own tables. This file is the entire coupling between
 * the two services.
 *
 * The block it returns is already rendered by discover's
 * formatInterestsForPrompt — including the sentence that bounds what the tutor
 * may do with it ("Use these only to pick examples and analogies. Never change
 * the academic content, difficulty, or correctness of an answer to match an
 * interest."). Do not re-render or summarise it here: that constraint travels
 * with the text, and this module must not be able to drop it.
 */
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_CONTEXT_LENGTH = 900;

function buildInterestContextUrl(baseUrl, input = {}) {
  const params = new URLSearchParams({ studentId: String(input.studentId || '') });
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/discover/internal/interest-context?${params}`;
}

/**
 * Interest text is derived from articles off the open web, so it is treated as
 * untrusted: bounded in length, stripped of anything that reads as an
 * instruction, and never allowed to carry newline-delimited directives beyond
 * the block discover itself composed.
 */
function normalizeInterestContext(payload = {}) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const raw = typeof payload.promptContext === 'string' ? payload.promptContext : '';
  const cleaned = raw
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => !/\b(?:ignore|disregard|system prompt|developer message|act as)\b/i.test(line))
    .join('\n')
    .slice(0, MAX_CONTEXT_LENGTH);
  return cleaned;
}

async function loadStudentInterestContext({
  studentId,
  baseUrl = process.env.DISCOVER_SERVICE_URL || 'http://discover:3008',
  token = process.env.INTERNAL_SERVICE_TOKEN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!studentId || !token) return '';

  try {
    const response = await fetchImpl(buildInterestContextUrl(baseUrl, { studentId }), {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-internal-service-token': token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeInterestContext(await response.json());
  } catch (err) {
    // Falling back to '' is deliberate: the tutor must still answer without
    // interest personalisation, and Discover being down must never take chat
    // with it. But a failure must not look identical to "this student has no
    // profile yet", so it is logged.
    console.warn('[ai] interest prompt context unavailable:', err.message);
    return '';
  }
}

module.exports = {
  buildInterestContextUrl,
  normalizeInterestContext,
  loadStudentInterestContext,
  MAX_CONTEXT_LENGTH,
};
