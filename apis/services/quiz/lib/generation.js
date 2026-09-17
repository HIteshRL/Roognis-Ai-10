const { needsGeneration } = require('./chapters');
const { QUIZ_STATUS, ACTIVE_STATUSES } = require('./quiz-status');
const { conceptIdForTag, misconceptionIdFor } = require('./concept-id');
const { resolveConcept } = require('../concept-mapping');

const DEFAULT_QUESTION_COUNT = 10;

function buildDifficultyPlan(questionCount = DEFAULT_QUESTION_COUNT) {
  const count = normalizeQuestionCount(questionCount);
  const weights = [
    ['simple', 0.5],
    ['medium', 0.3],
    ['hard', 0.2],
  ];
  const planned = weights.map(([difficulty, weight], index) => {
    const exact = count * weight;
    return {
      difficulty,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      index,
    };
  });
  let assigned = planned.reduce((sum, item) => sum + item.count, 0);
  planned
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach(item => {
      if (assigned >= count) return;
      item.count += 1;
      assigned += 1;
    });
  return Object.fromEntries(planned.map(item => [item.difficulty, item.count]));
}

async function generateQuizForSource(prisma, sourceInput, options = {}) {
  const source = typeof sourceInput === 'string'
    ? await prisma.chapterQuizSource.findUnique({ where: { id: sourceInput } })
    : sourceInput;
  if (!source) throw new Error('Chapter quiz source not found.');

  const activeQuiz = await findActiveQuiz(prisma, source);
  if (!options.force && !needsGeneration(source, activeQuiz)) {
    // Mirror the quiz's real status onto the source rather than assuming
    // `ready` — an existing quiz may still be awaiting teacher approval, and
    // stamping the source `ready` would advertise it as publishable.
    if (source.quizStatus !== activeQuiz.status || source.activeQuizId !== activeQuiz.id) {
      await prisma.chapterQuizSource.update({
        where: { id: source.id },
        data: {
          quizStatus: activeQuiz.status,
          activeQuizId: activeQuiz.id,
          lastGenerationError: null,
          lastGeneratedAt: source.lastGeneratedAt || activeQuiz.createdAt,
        },
      });
    }
    return { status: 'skipped', sourceId: source.id, quizId: activeQuiz.id };
  }

  const job = await prisma.quizGenerationJob.create({
    data: {
      sourceId: source.id,
      trigger: options.trigger || 'manual',
      status: 'running',
      metadata: {
        contentFingerprint: source.contentFingerprint,
      },
    },
  });

  try {
    await prisma.chapterQuizSource.update({
      where: { id: source.id },
      data: { quizStatus: 'generating', lastGenerationError: null },
    });

    const context = await fetchRagChapterContext(source, options);
    if (!Array.isArray(context.chunks) || context.chunks.length < 2) {
      throw new Error('RAG chapter context does not contain enough chunks for quiz generation.');
    }

    const questionCount = Number(options.questionCount || process.env.QUIZ_QUESTION_COUNT || DEFAULT_QUESTION_COUNT);
    const difficultyCounts = buildDifficultyPlan(questionCount);
    const draftResult = await requestAiQuizDraft(source, context, {
      ...options,
      questionCount,
      difficultyCounts,
    });
    const quiz = await persistQuizDraft(prisma, source, draftResult, {
      context,
      teacherId: options.teacherId || null,
      jobId: job.id,
      questionCount,
      difficultyCounts,
    });

    return { status: 'generated', sourceId: source.id, quizId: quiz.id };
  } catch (err) {
    await prisma.$transaction([
      prisma.quizGenerationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          error: err.message,
          completedAt: new Date(),
        },
      }),
      prisma.chapterQuizSource.update({
        where: { id: source.id },
        data: {
          quizStatus: 'failed',
          lastGenerationError: err.message,
        },
      }),
    ]);
    throw err;
  }
}

async function findActiveQuiz(prisma, source) {
  if (source.activeQuizId) {
    const quiz = await prisma.quiz.findUnique({ where: { id: source.activeQuizId } });
    if (quiz) return quiz;
  }
  return prisma.quiz.findFirst({
    where: {
      sourceId: source.id,
      // A quiz awaiting review still occupies the slot; treating only `ready`
      // as active would regenerate over a teacher's pending decision.
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function fetchRagChapterContext(source, options = {}) {
  const ragUrl = options.ragServiceUrl || process.env.RAG_SERVICE_URL || 'http://rag:3003';
  const token = options.internalServiceToken || process.env.INTERNAL_SERVICE_TOKEN || '';
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required to fetch RAG chapter context.');

  const params = new URLSearchParams({ maxChunks: String(options.maxChunks || 80) });
  const documentIds = Array.isArray(source.documentIds) ? source.documentIds.filter(Boolean) : [];
  if (documentIds.length) {
    params.set('documentIds', documentIds.join(','));
  } else {
    params.set('schoolId', source.schoolId);
    params.set('subject', source.subject);
    params.set('grade', String(source.grade));
    params.set('chapterNumber', String(source.chapterNumber));
    params.set('board', source.board);
    params.set('curriculum', source.curriculum);
    params.set('book', source.book);
    params.set('language', source.language);
    params.set('edition', source.edition);
  }

  return fetchJson(
    `${ragUrl.replace(/\/+$/, '')}/api/rag/internal/chapter-context?${params.toString()}`,
    {
      method: 'GET',
      headers: { 'X-Internal-Service-Token': token },
    },
    options.ragTimeoutMs || 10000,
    options.fetchFn
  );
}

async function requestAiQuizDraft(source, context, options = {}) {
  const aiUrl = options.aiServiceUrl || process.env.AI_SERVICE_URL || 'http://ai:3002';
  const token = options.internalServiceToken || process.env.INTERNAL_SERVICE_TOKEN || '';
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required to request AI quiz drafts.');

  const payload = {
    chapter: {
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
    },
    sourceChunks: context.chunks,
    questionCount: options.questionCount,
    difficultyCounts: options.difficultyCounts,
    teacherId: options.teacherId || null,
  };

  return fetchJson(
    `${aiUrl.replace(/\/+$/, '')}/api/ai/quiz/draft`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': token,
      },
      body: JSON.stringify(payload),
    },
    options.aiTimeoutMs || 90000,
    options.fetchFn
  );
}

async function persistQuizDraft(prisma, source, draftResult, options = {}) {
  const draft = draftResult.draft;
  const counts = countDifficulties(draft.questions || []);
  const quiz = await prisma.$transaction(async tx => {
    // Archive whatever currently occupies the slot — an approved quiz *or* one
    // still awaiting review. Only matching `ready` here would leave an orphaned
    // pending draft behind on every regeneration.
    await tx.quiz.updateMany({
      where: {
        sourceId: source.id,
        status: { in: ACTIVE_STATUSES },
      },
      data: { status: QUIZ_STATUS.ARCHIVED },
    });

    const created = await tx.quiz.create({
      data: {
        sourceId: source.id,
        schoolId: source.schoolId,
        teacherId: options.teacherId || null,
        title: draft.title,
        chapterSummary: draft.chapterSummary,
        // Not `ready`. A teacher approves before any student can open it —
        // nothing here can verify that the model's answer keys are correct.
        status: QUIZ_STATUS.PENDING_REVIEW,
        questionCount: draft.questions.length,
        simpleCount: counts.simple,
        mediumCount: counts.medium,
        hardCount: counts.hard,
        generationModel: draftResult.model || null,
        contentFingerprint: source.contentFingerprint,
        sourceCoverage: draft.coverage || [],
        questions: {
          create: draft.questions
            .slice()
            .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
            .map((question, index) => {
              const conceptId = resolveConcept(question.conceptTag, {
                chapter: { ...source, conceptCatalog: options.context?.chapter?.conceptCatalog || [] },
                chunks: options.context?.chunks || [], sourceChunkIds: question.sourceChunkIds || [],
                allowTeacherProposal: true,
              });
              if (!conceptId) throw new Error('Ambiguous concept mapping: revise the concept label or cited sources before approval.');
              const misconceptionId = misconceptionIdFor(conceptId, question.weakAreaLabel);
              return {
                orderIndex: index + 1,
                type: question.type,
                difficulty: question.difficulty,
                bloomLevel: question.bloomLevel,
                conceptTag: question.conceptTag,
                conceptId,
                misconceptionIds: misconceptionId ? [misconceptionId] : [],
                weakAreaLabel: question.weakAreaLabel,
                prompt: question.prompt,
                options: Array.isArray(question.options) ? question.options : [],
                correctAnswer: question.correctAnswer,
                explanation: question.explanation,
                sourceChunkIds: question.sourceChunkIds || [],
                marks: Number(question.marks || 1),
              };
            }),
        },
      },
      include: { questions: true },
    });

    await tx.chapterQuizSource.update({
      where: { id: source.id },
      data: {
        quizStatus: QUIZ_STATUS.PENDING_REVIEW,
        activeQuizId: created.id,
        lastGenerationError: null,
        lastGeneratedAt: new Date(),
      },
    });

    await tx.quizGenerationJob.update({
      where: { id: options.jobId },
      data: {
        quizId: created.id,
        status: 'succeeded',
        completedAt: new Date(),
        metadata: {
          questionCount: created.questionCount,
          simpleCount: created.simpleCount,
          mediumCount: created.mediumCount,
          hardCount: created.hardCount,
          model: created.generationModel,
        },
      },
    });

    return created;
  });

  return quiz;
}

async function fetchReadyRagChapters(options = {}) {
  const ragUrl = options.ragServiceUrl || process.env.RAG_SERVICE_URL || 'http://rag:3003';
  const token = options.internalServiceToken || process.env.INTERNAL_SERVICE_TOKEN || '';
  if (!token) throw new Error('INTERNAL_SERVICE_TOKEN is required to fetch RAG chapters.');

  const params = new URLSearchParams();
  if (options.schoolId) params.set('schoolId', options.schoolId);
  if (options.subject) params.set('subject', options.subject);
  if (options.grade) params.set('grade', String(options.grade));

  return fetchJson(
    `${ragUrl.replace(/\/+$/, '')}/api/rag/internal/chapters?${params.toString()}`,
    {
      method: 'GET',
      headers: { 'X-Internal-Service-Token': token },
    },
    options.ragTimeoutMs || 10000,
    options.fetchFn
  );
}

async function fetchJson(url, options, timeoutMs, fetchFn = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) payload = JSON.parse(text);
    if (!response.ok) {
      throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function countDifficulties(questions) {
  return questions.reduce(
    (counts, question) => {
      if (question.difficulty in counts) counts[question.difficulty] += 1;
      return counts;
    },
    { simple: 0, medium: 0, hard: 0 }
  );
}

function normalizeQuestionCount(value) {
  const numeric = Number(value || DEFAULT_QUESTION_COUNT);
  if (!Number.isInteger(numeric) || numeric < 5 || numeric > 30) {
    throw new Error('QUIZ_QUESTION_COUNT must be an integer from 5 to 30.');
  }
  return numeric;
}

module.exports = {
  DEFAULT_QUESTION_COUNT,
  buildDifficultyPlan,
  generateQuizForSource,
  fetchRagChapterContext,
  requestAiQuizDraft,
  persistQuizDraft,
  fetchReadyRagChapters,
  countDifficulties,
};
