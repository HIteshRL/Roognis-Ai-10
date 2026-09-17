const { QUIZ_STATUS } = require('./quiz-status');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildStudentAttemptWhere(input = {}) {
  const studentId = requiredUuid(input.studentId, 'studentId');
  const schoolId = requiredUuid(input.schoolId, 'schoolId');
  const source = {};

  if (cleanString(input.subject)) source.subject = cleanString(input.subject);
  if (positiveInteger(input.grade)) source.grade = positiveInteger(input.grade);
  if (positiveInteger(input.chapterNumber)) source.chapterNumber = positiveInteger(input.chapterNumber);

  return {
    studentId,
    schoolId,
    // Approved quizzes only — an unreviewed draft must not shape a learner's
    // personalisation context any more than it may be sat as an assessment.
    quiz: { is: { status: QUIZ_STATUS.READY } },
    source: { is: source },
  };
}

function buildStudentLearningContext(attempts = [], scope = {}, cardOutcomes = []) {
  const areas = new Map();
  const recentScores = [];

  for (const attempt of attempts) {
    const submittedAt = asIsoDate(attempt?.submittedAt);
    const percentage = finiteNumber(attempt?.percentage);
    if (percentage !== null) {
      recentScores.push({
        percentage,
        submittedAt,
        subject: cleanString(attempt?.source?.subject),
        grade: positiveInteger(attempt?.source?.grade),
        chapterNumber: positiveInteger(attempt?.source?.chapterNumber),
        chapterName: cleanString(attempt?.source?.chapterName),
      });
    }

    const attemptDocumentIds = normalizeDocumentIds(attempt?.source?.documentIds);
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
        difficulties: new Set(),
        documentIds: new Set(),
        lastSeenAt: null,
      };
      existing.missedAttempts += 1;
      const conceptTag = safeLabel(rawArea?.conceptTag);
      const difficulty = cleanString(rawArea?.difficulty);
      if (conceptTag) existing.conceptTags.add(conceptTag);
      if (['simple', 'medium', 'hard'].includes(difficulty)) existing.difficulties.add(difficulty);
      for (const documentId of attemptDocumentIds) existing.documentIds.add(documentId);
      if (submittedAt && (!existing.lastSeenAt || submittedAt > existing.lastSeenAt)) {
        existing.lastSeenAt = submittedAt;
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
      difficulties: new Set(),
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
      difficulties: [...area.difficulties],
      documentIds: [...area.documentIds].slice(0, 4),
      lastSeenAt: area.lastSeenAt,
    }));

  const averageScorePercent = recentScores.length
    ? Math.round((recentScores.reduce((sum, item) => sum + item.percentage, 0) / recentScores.length) * 100) / 100
    : null;

  return {
    scope: {
      subject: cleanString(scope.subject),
      grade: positiveInteger(scope.grade),
      chapterNumber: positiveInteger(scope.chapterNumber),
    },
    attemptCount: attempts.length,
    averageScorePercent,
    weakAreas,
    recentScores: recentScores.slice(0, 5),
  };
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

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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
  buildStudentAttemptWhere,
  buildStudentLearningContext,
  normalizeDocumentIds,
  safeLabel,
};
