/** LMS roster gate and durable score delivery client.
 * Access checks fail closed when LMS cannot verify the current enrollment.
 */

const LMS_SERVICE_URL = process.env.LMS_SERVICE_URL || 'http://lms:3006';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';

// An explicit LMS response for a quiz without linked coursework.
const UNLINKED = Object.freeze({
  linked: false,
  allowed: false,
  classroomId: null,
  courseworkId: null,
  maxPoints: null,
});

async function fetchJson(url, options, timeoutMs, fetchFn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Blocking — the caller needs the answer before deciding whether to serve
 * a quiz. Fails open to UNLINKED on any error (not configured, timeout,
 * non-2xx), per the module docstring.
 */
async function checkQuizAccess({ quizId, studentId }, fetchFn = fetch) {
  if (!LMS_SERVICE_URL || !INTERNAL_SERVICE_TOKEN) throw new Error('LMS authorization is unavailable.');
  try {
    const params = new URLSearchParams({ quizId: String(quizId), studentId: String(studentId) });
    const payload = await fetchJson(
      `${LMS_SERVICE_URL.replace(/\/+$/, '')}/api/lms/internal/quiz-access?${params}`,
      { method: 'GET', headers: { 'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN } },
      3000,
      fetchFn,
    );
    if (!payload || typeof payload.linked !== 'boolean' || typeof payload.allowed !== 'boolean') throw new Error('Invalid LMS authorization response.');
    return payload;
  } catch (error) {
    console.warn('[quiz] LMS quiz-access check unavailable:', error.message);
    throw new Error('LMS authorization is unavailable.');
  }
}

/**
 * Fire-and-forget — mirrors fireAnalyticsEvent's contract. Never awaited by
 * a request handler for its result; a down LMS Service must not delay or
 * fail a student's quiz submission response. The grade simply doesn't land
 * on the LMS side until the next successful attempt or a manual re-sync;
 * there is no queue or retry here, matching every other fire-and-forget
 * cross-service call in this codebase (see CLAUDE.md's "fire-and-forget"
 * references for analytics).
 */
function reportQuizScore({ quizId, studentId, score, maxScore, attemptId }, fetchFn = fetch) {
  if (!LMS_SERVICE_URL || !INTERNAL_SERVICE_TOKEN) return;
  fetchJson(
    `${LMS_SERVICE_URL.replace(/\/+$/, '')}/api/lms/internal/quiz-score`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify({ quizId, studentId, score, maxScore, attemptId }),
    },
    3000,
    fetchFn,
  ).catch(error => {
    console.warn('[quiz] LMS quiz-score report failed (fire-and-forget):', error.message);
  });
}

module.exports = { checkQuizAccess, reportQuizScore, UNLINKED };
