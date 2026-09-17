/**
 * Aggregating one student's practice-attempt history for the tutor's
 * personalization prompt.
 *
 * Mirrors services/quiz/lib/student-learning.js in shape, with one
 * simplification: PracticeSet stores only a hashed chapterKey (same caching
 * pattern as VisualArtifact), not raw subject/grade/chapterNumber columns, so
 * this cannot scope by lesson the way the quiz-service version does. It
 * aggregates across the student's whole recent practice history instead of
 * one lesson's slice. There is no approval-status filter here — every
 * PracticeAttempt is already ungated by design, unlike quiz's `status:'ready'`
 * gate on QuizAttempt.
 */
const { createHash } = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildStudentAttemptWhere(input = {}) {
  const studentId = requiredUuid(input.studentId, 'studentId');
  const schoolId = requiredUuid(input.schoolId, 'schoolId');
  return { studentId, schoolId, completedAt: { not: null } };
}

function buildPracticeLearningContext(attempts = [], cardOutcomes = []) {
  const areas = new Map();
  const recentScores = [];

  for (const attempt of attempts) {
    const completedAt = asIsoDate(attempt?.completedAt);
    const percentage = finiteNumber(attempt?.result?.percentage);
    if (percentage !== null) {
      recentScores.push({ percentage, completedAt });
    }

    const attemptDocumentIds = normalizeDocumentIds(attempt?.practiceSet?.documentIds);
    const weakAreas = Array.isArray(attempt?.result?.weakAreas) ? attempt.result.weakAreas : [];
    const seenInAttempt = new Set();
    for (const rawArea of weakAreas) {
      const label = safeLabel(rawArea?.label);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seenInAttempt.has(key)) continue;
      seenInAttempt.add(key);

      const existing = areas.get(key) || {
        label,
        missedAttempts: 0,
        conceptTags: new Set(),
        documentIds: new Set(),
        lastSeenAt: null,
      };
      existing.missedAttempts += 1;
      const conceptTag = safeLabel(rawArea?.conceptTag);
      if (conceptTag) existing.conceptTags.add(conceptTag);
      for (const documentId of attemptDocumentIds) existing.documentIds.add(documentId);
      if (completedAt && (!existing.lastSeenAt || completedAt > existing.lastSeenAt)) {
        existing.lastSeenAt = completedAt;
      }
      areas.set(key, existing);
    }
  }


  // Loop closure for ambient academic revision. A missed micro-recall on an
  // Academic Card is the same class of evidence as a missed question here, so
  // it merges into the same aggregation rather than living in a parallel list
  // the consumers would have to learn about. Only incorrect outcomes ever
  // arrive (fetchCardOutcomes filters, and re-checks), so a correct recall can
  // never raise missedAttempts. Discover unreachable => [] => zero iterations.
  for (const outcome of Array.isArray(cardOutcomes) ? cardOutcomes : []) {
    const label = safeLabel(outcome?.label);
    if (!label) continue;
    const key = label.toLowerCase();

    const existing = areas.get(key) || {
      label,
      missedAttempts: 0,
      conceptTags: new Set(),
      documentIds: new Set(),
      lastSeenAt: null,
    };
    // No per-outcome dedupe: each outcome is one distinct card attempt, and
    // missing the same concept twice is two pieces of evidence.
    existing.missedAttempts += 1;
    const conceptTag = safeLabel(outcome?.conceptTag);
    if (conceptTag) existing.conceptTags.add(conceptTag);
    for (const documentId of normalizeDocumentIds(outcome?.documentIds)) {
      existing.documentIds.add(documentId);
    }
    const answeredAt = asIsoDate(outcome?.answeredAt);
    if (answeredAt && (!existing.lastSeenAt || answeredAt > existing.lastSeenAt)) {
      existing.lastSeenAt = answeredAt;
    }
    areas.set(key, existing);
  }

  const weakAreas = [...areas.values()]
    .sort((a, b) => (
      b.missedAttempts - a.missedAttempts
      || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
      || a.label.localeCompare(b.label)
    ))
    .slice(0, 8)
    .map(area => ({
      label: area.label,
      missedAttempts: area.missedAttempts,
      conceptTags: [...area.conceptTags].slice(0, 4),
      documentIds: [...area.documentIds].slice(0, 4),
      lastSeenAt: area.lastSeenAt,
    }));

  const averageScorePercent = recentScores.length
    ? Math.round((recentScores.reduce((sum, item) => sum + item.percentage, 0) / recentScores.length) * 100) / 100
    : null;

  return {
    attemptCount: attempts.length,
    averageScorePercent,
    weakAreas,
  };
}

/**
 * Per-student content targeting (Q3).
 *
 * The only per-student targeting mechanism in the product. It lives here and
 * not in services/quiz on purpose: a Quiz is one shared, teacher-approved
 * object per chapter source, so per-student variants would multiply
 * unreviewable content past what a human can gate. A PracticeSet is already
 * scoped to one student and already ungated by product decision, so targeting
 * it changes emphasis for that student and nothing else.
 *
 * This is a pure function of already-aggregated weak areas. No LLM sees it,
 * and it never decides difficulty, routing, or whether content is shown — it
 * only nominates which concepts the extraction pass should lean on, which
 * keeps it the right side of MASTERCONTEXT §7.
 */
const CONCEPT_PRIORITY_MIN_MISSED_ATTEMPTS = 2;
const CONCEPT_PRIORITY_MAX = 3;

function buildConceptPriorityPlan(weakAreas = []) {
  if (!Array.isArray(weakAreas)) return [];
  return weakAreas
    // One miss is noise; two is a pattern worth spending question slots on.
    .filter(area => Number(area?.missedAttempts) >= CONCEPT_PRIORITY_MIN_MISSED_ATTEMPTS)
    // Already ordered by missedAttempts then recency by buildPracticeLearningContext.
    .slice(0, CONCEPT_PRIORITY_MAX)
    .map(area => ({
      label: safeLabel(area?.label),
      conceptTags: (Array.isArray(area?.conceptTags) ? area.conceptTags : [])
        .map(tag => safeLabel(tag))
        .filter(Boolean)
        .slice(0, 4),
      missedAttempts: Number(area.missedAttempts),
    }))
    .filter(entry => entry.label);
}

/**
 * Stable hash of a plan, for the cache key.
 *
 * Without this, a targeted set and a generic one for the same chapter share a
 * cache row and whichever was generated first wins — a student who has since
 * developed a weak area would keep being served the untargeted set. Sorted
 * before hashing so an ordering change with identical content does not
 * needlessly invalidate a cached set. Empty plan => '' => untargeted, which
 * is exactly what every pre-existing row already carries.
 */
function targetingFingerprintFor(conceptPriority = []) {
  const labels = (Array.isArray(conceptPriority) ? conceptPriority : [])
    .map(entry => String(entry?.label || '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (!labels.length) return '';
  return createHash('sha256').update(labels.join('|')).digest('hex').slice(0, 32);
}

function requiredUuid(value, field) {
  const cleaned = cleanString(value);
  if (!cleaned || !UUID_RE.test(cleaned)) throw new Error(`${field} must be a valid UUID.`);
  return cleaned;
}

function safeLabel(value) {
  const cleaned = cleanString(value)?.replace(/\s+/g, ' ').slice(0, 100) || '';
  if (!cleaned) return null;
  if (/\b(?:ignore|disregard|system prompt|developer message|instruction|act as)\b/i.test(cleaned)) return null;
  return cleaned;
}

/**
 * The RAG documents a weak area came from. This is what makes an area
 * card-eligible in services/discover: without document ids a card has no
 * honest way to ground itself in the chapter the student actually missed,
 * and selectCardTarget() drops the area rather than guessing.
 *
 * Defensive about shape because the quiz source column is Json, not TEXT[].
 */
function normalizeDocumentIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => id.trim())
    .slice(0, 8);
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  CONCEPT_PRIORITY_MIN_MISSED_ATTEMPTS,
  CONCEPT_PRIORITY_MAX,
  buildStudentAttemptWhere,
  buildPracticeLearningContext,
  buildConceptPriorityPlan,
  targetingFingerprintFor,
  normalizeDocumentIds,
  safeLabel,
};
