const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeChapterPayload,
  upsertChapterSource,
  sourceIdentityWhere,
  needsGeneration,
  sanitizeChapterSource,
} = require('../lib/chapters');
const {
  buildDifficultyPlan,
  countDifficulties,
} = require('../lib/generation');
const {
  gradeQuizAttempt,
  normalizeSubmittedAnswers,
} = require('../lib/scoring');

function sampleChapter(overrides = {}) {
  return {
    schoolId: '22222222-2222-2222-2222-222222222222',
    board: 'CBSE',
    curriculum: 'NCERT',
    grade: 8,
    subject: 'Science',
    book: 'Curiosity',
    chapterNumber: 10,
    chapterName: 'Light',
    language: 'English',
    edition: '2026-27',
    documentIds: ['doc-1'],
    documentCount: 1,
    entityCount: 12,
    chunkCount: 9,
    contentFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

test('normalizes chapter payload into a stable quiz source identity', () => {
  const chapter = normalizeChapterPayload(sampleChapter());
  const where = sourceIdentityWhere(chapter);

  assert.equal(chapter.subject, 'Science');
  assert.equal(chapter.grade, 8);
  assert.deepEqual(chapter.documentIds, ['doc-1']);
  assert.equal(where.source_identity.chapterNumber, 10);
  assert.equal(where.source_identity.language, 'English');
});

test('requires core chapter identity fields', () => {
  assert.throws(
    () => normalizeChapterPayload(sampleChapter({ subject: '   ' })),
    /subject is required/
  );
});

test('detects when source needs generation', () => {
  const source = { contentFingerprint: 'new', activeQuizId: null };

  assert.equal(needsGeneration(source, null), true);
  assert.equal(needsGeneration(source, { status: 'ready', contentFingerprint: 'new' }), false);
  assert.equal(needsGeneration(source, { status: 'ready', contentFingerprint: 'old' }), true);
  assert.equal(needsGeneration(source, { status: 'archived', contentFingerprint: 'new' }), true);
});

test('upserts ready RAG chapter payload without leaking document status into source create', async () => {
  let createData = null;
  const prisma = {
    chapterQuizSource: {
      findUnique: async () => null,
      create: async input => {
        createData = input.data;
        return input.data;
      },
    },
  };

  await upsertChapterSource(prisma, sampleChapter({ status: 'ready' }));

  assert.equal(createData.status, undefined);
  assert.equal(createData.quizStatus, 'missing');
  assert.equal(createData.chapterName, 'Light');
});

test('builds 50/30/20 difficulty plan and counts questions', () => {
  assert.deepEqual(buildDifficultyPlan(10), { simple: 5, medium: 3, hard: 2 });
  assert.deepEqual(
    countDifficulties([
      { difficulty: 'simple' },
      { difficulty: 'medium' },
      { difficulty: 'hard' },
      { difficulty: 'simple' },
    ]),
    { simple: 2, medium: 1, hard: 1 }
  );
});

test('sanitizes source response with quiz summary', () => {
  const source = {
    id: 'source-1',
    ...sampleChapter(),
    quizStatus: 'ready',
    activeQuizId: 'quiz-1',
    lastGenerationError: null,
    lastGeneratedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const quiz = {
    id: 'quiz-1',
    title: 'Light quiz',
    status: 'ready',
    questionCount: 10,
    simpleCount: 5,
    mediumCount: 3,
    hardCount: 2,
    generationModel: 'openai/gpt-5-mini',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const response = sanitizeChapterSource(source, quiz);

  assert.equal(response.sourceId, 'source-1');
  assert.equal(response.quiz.quizId, 'quiz-1');
  assert.equal(response.quiz.hardCount, 2);
});

test('grades student quiz attempts without trusting unknown answer keys', () => {
  const quiz = {
    questions: [
      {
        id: 'q1',
        orderIndex: 1,
        type: 'mcq',
        difficulty: 'simple',
        conceptTag: 'Reflection',
        weakAreaLabel: 'Plane mirror basics',
        prompt: 'Which mirror forms a virtual image?',
        correctAnswer: 'Plane mirror',
        explanation: 'Plane mirrors form virtual, erect images.',
        marks: 1,
      },
      {
        id: 'q2',
        orderIndex: 2,
        type: 'short_answer',
        difficulty: 'hard',
        conceptTag: 'Photosynthesis',
        weakAreaLabel: 'Food making in leaves',
        prompt: 'Name the food-making process in green plants.',
        correctAnswer: 'Photosynthesis',
        explanation: 'Green plants make food by photosynthesis.',
        marks: 2,
      },
    ],
  };

  const normalized = normalizeSubmittedAnswers({ q1: 'Plane mirror', q2: 'Photosynthesis happens in leaves', q3: 'ignored' }, quiz.questions);
  const graded = gradeQuizAttempt(quiz, normalized);

  assert.deepEqual(Object.keys(normalized), ['q1', 'q2']);
  assert.equal(graded.score, 3);
  assert.equal(graded.maxScore, 3);
  assert.equal(graded.percentage, 100);
  assert.equal(graded.results.every(item => item.correct), true);
});
