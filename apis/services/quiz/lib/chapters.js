const crypto = require('crypto');

const { isActive } = require('./quiz-status');

const DEFAULT_TEXT = 'Unknown';

function normalizeChapterPayload(input = {}) {
  const chapter = input.chapter || input;
  const schoolId = requiredString(chapter.schoolId, 'schoolId');
  const subject = requiredString(chapter.subject, 'subject');
  const grade = requiredInteger(chapter.grade, 'grade', 1, 12);
  const chapterNumber = requiredInteger(chapter.chapterNumber, 'chapterNumber', 1, 500);
  const chapterName = requiredString(chapter.chapterName, 'chapterName');
  const documentIds = normalizeStringArray(chapter.documentIds);
  const fingerprint = cleanString(chapter.contentFingerprint) || fallbackFingerprint(chapter);

  return {
    schoolId,
    board: cleanString(chapter.board) || DEFAULT_TEXT,
    curriculum: cleanString(chapter.curriculum) || DEFAULT_TEXT,
    grade,
    subject,
    book: cleanString(chapter.book) || DEFAULT_TEXT,
    chapterNumber,
    chapterName,
    language: cleanString(chapter.language) || 'English',
    edition: cleanString(chapter.edition) || DEFAULT_TEXT,
    documentIds,
    documentCount: integerOrZero(chapter.documentCount) || documentIds.length,
    entityCount: integerOrZero(chapter.entityCount),
    chunkCount: integerOrZero(chapter.chunkCount),
    contentFingerprint: fingerprint,
    status: cleanString(chapter.status) || 'ready',
  };
}

function sourceIdentityWhere(chapter) {
  return {
    source_identity: {
      schoolId: chapter.schoolId,
      board: chapter.board,
      curriculum: chapter.curriculum,
      grade: chapter.grade,
      subject: chapter.subject,
      book: chapter.book,
      chapterNumber: chapter.chapterNumber,
      language: chapter.language,
      edition: chapter.edition,
    },
  };
}

async function upsertChapterSource(prisma, payload) {
  const chapter = normalizeChapterPayload(payload);
  const { status: _status, ...sourceData } = chapter;
  const where = sourceIdentityWhere(chapter);
  const existing = await prisma.chapterQuizSource.findUnique({ where });
  if (existing) {
    const contentChanged = existing.contentFingerprint !== chapter.contentFingerprint;
    return prisma.chapterQuizSource.update({
      where,
      data: {
        chapterName: chapter.chapterName,
        documentIds: chapter.documentIds,
        documentCount: chapter.documentCount,
        entityCount: chapter.entityCount,
        chunkCount: chapter.chunkCount,
        contentFingerprint: chapter.contentFingerprint,
        quizStatus: contentChanged ? 'missing' : existing.quizStatus,
        lastGenerationError: contentChanged ? null : existing.lastGenerationError,
      },
    });
  }

  return prisma.chapterQuizSource.create({
    data: {
      ...sourceData,
      quizStatus: 'missing',
    },
  });
}

function needsGeneration(source, activeQuiz) {
  if (!source) return false;
  if (!activeQuiz) return true;
  // `isActive` covers both `ready` and `pending_review`. Testing for `ready`
  // alone meant a quiz sitting in review looked like a missing quiz, so every
  // sync would regenerate over the teacher's pending decision and re-spend the
  // model call.
  if (!isActive(activeQuiz.status)) return true;
  return activeQuiz.contentFingerprint !== source.contentFingerprint;
}

function sanitizeChapterSource(source, quiz = null) {
  return {
    sourceId: source.id,
    schoolId: source.schoolId,
    board: source.board,
    curriculum: source.curriculum,
    grade: source.grade,
    subject: source.subject,
    book: source.book,
    chapterNumber: source.chapterNumber,
    chapterName: source.chapterName,
    language: source.language,
    edition: source.edition,
    documentIds: Array.isArray(source.documentIds) ? source.documentIds : [],
    documentCount: source.documentCount,
    entityCount: source.entityCount,
    chunkCount: source.chunkCount,
    contentFingerprint: source.contentFingerprint,
    quizStatus: source.quizStatus,
    activeQuizId: source.activeQuizId,
    lastGenerationError: source.lastGenerationError,
    lastGeneratedAt: source.lastGeneratedAt,
    updatedAt: source.updatedAt,
    quiz: quiz ? sanitizeQuizSummary(quiz) : null,
  };
}

function sanitizeQuizSummary(quiz) {
  return {
    quizId: quiz.id,
    title: quiz.title,
    status: quiz.status,
    questionCount: quiz.questionCount,
    simpleCount: quiz.simpleCount,
    mediumCount: quiz.mediumCount,
    hardCount: quiz.hardCount,
    generationModel: quiz.generationModel,
    createdAt: quiz.createdAt,
    updatedAt: quiz.updatedAt,
  };
}

function requiredString(value, field) {
  const cleaned = cleanString(value);
  if (!cleaned) throw new Error(`${field} is required.`);
  return cleaned;
}

function requiredInteger(value, field, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return numeric;
}

function cleanString(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => cleanString(item)).filter(Boolean);
}

function integerOrZero(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function fallbackFingerprint(chapter) {
  const digest = crypto.createHash('sha256');
  digest.update(JSON.stringify({
    schoolId: chapter.schoolId,
    subject: chapter.subject,
    grade: chapter.grade,
    chapterNumber: chapter.chapterNumber,
    chapterName: chapter.chapterName,
    documentIds: chapter.documentIds || [],
    chunkCount: chapter.chunkCount || 0,
  }));
  return digest.digest('hex');
}

module.exports = {
  normalizeChapterPayload,
  sourceIdentityWhere,
  upsertChapterSource,
  needsGeneration,
  sanitizeChapterSource,
  sanitizeQuizSummary,
};
