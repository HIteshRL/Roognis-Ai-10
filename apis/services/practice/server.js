const {requireDocumentAccess, accessibleDocumentIds} = require('./document-access');
require('./load-env');
const { enqueueEvidence, startEvidenceWorker } = require('./evidence-outbox');
const { loadAcademicSupport, orderPractice, supportForChapter } = require('./academic-support');

const express = require('express');
const cookieParser = require('cookie-parser');
const { createHash } = require('node:crypto');
const prisma = require('./lib/prisma');
const generationQueue = require('./generation-queue').createQueue(prisma, 'practice_db');

const requireAuth = require('./middleware/auth');
const requireInternalToken = require('./middleware/internal-token');
const { fetchChapterContext, selectGroundingChunks, chapterKeyFor, buildProvenance } = require('./grounding');
const { generatePracticeSet } = require('./generate');
const { gradePracticeAttempt } = require('./scoring');
const { collectPracticeSetText } = require('./validate');
const { validateGeneratedTextSafety } = require('./safety');
const {
  buildStudentAttemptWhere,
  buildPracticeLearningContext,
  buildConceptPriorityPlan,
  targetingFingerprintFor,
} = require('./student-learning');
const { fetchCardOutcomes } = require('./discover-card-outcomes');
const { GRADES, initialState, gradeReview } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3007;
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:3004';
const PSV_SERVICE_URL = process.env.PSV_SERVICE_URL || 'http://psv:3011';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const studentOnly = [requireAuth, requireAuth.requireRole('student')];
const backgroundTasks = new Set();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'practice' }));
app.get('/api/practice/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'practice' }));

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Resolve a documentId to its chapter identity + usable chunks.
 *
 * Shared by POST /api/practice and GET /api/practice — both need the same
 * server-derived chapterKey, and the client must never be trusted to compute
 * it itself (it holds only 6 of the 9 fields in the identity tuple).
 */
async function resolveChapterForDocument(documentId, schoolId) {
  const context = await fetchChapterContext({ documentIds: [documentId] });
  const chapter = context?.chapter;
  if (!chapter || String(chapter.schoolId) !== String(schoolId)) {
    return { error: { status: 404, body: { error: 'Chapter not found.' } } };
  }
  const chunks = selectGroundingChunks(context);
  try {
    const params = new URLSearchParams({ schoolId, documentId });
    const response = await fetch(`${process.env.QUIZ_SERVICE_URL || 'http://quiz:3005'}/api/quiz/internal/concept-catalog?${params}`, {
      headers: { 'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN }, signal: AbortSignal.timeout(2500),
    });
    if (response.ok) chapter.conceptCatalog = [...(chapter.conceptCatalog || []), ...((await response.json()).concepts || [])];
  } catch (_) { /* Unknown mappings remain unscored, never guessed. */ }
  return { chapter, chunks, chapterKey: chapterKeyFor(chapter) };
}

/**
 * Which concepts should this student's next practice set lean on?
 *
 * The product's only per-student content targeting. Deterministic end to end:
 * a Prisma read, then a pure function. Fails soft — a student with no history,
 * or a read that throws, gets an untargeted set rather than no set at all.
 *
 * The attempt query here MUST stay in sync with the one in
 * GET /api/practice/internal/student-learning-context. They are separate
 * queries because they answer different requests, but they feed the same
 * builder, and a select that drops a field on one side silently changes what
 * the other side's weak areas contain.
 */
async function resolveConceptPriority({ studentId, schoolId }) {
  try {
    const where = buildStudentAttemptWhere({ studentId, schoolId });
    const [attempts, cardOutcomes] = await Promise.all([
      prisma.practiceAttempt.findMany({
        where,
        orderBy: { completedAt: 'desc' },
        take: 10,
        select: {
          completedAt: true,
          result: true,
          practiceSet: { select: { documentIds: true } },
        },
      }),
      fetchCardOutcomes({ studentId }),
    ]);
    const { weakAreas } = buildPracticeLearningContext(attempts, cardOutcomes);
    return buildConceptPriorityPlan(weakAreas);
  } catch (err) {
    console.warn('[practice] concept priority unavailable:', err.message);
    return [];
  }
}

/**
 * Request instant practice content for a lesson.
 *
 * Async for the same reason the visuals path is: the model call is
 * 10-60s, far too long to hold a request open on a slow connection.
 * Deliberately no teacher-approval gate — see CLAUDE.md and HANDOFF.md for
 * why this pipeline is intentionally separate from services/quiz's gated one.
 */
app.post('/api/practice', ...studentOnly, asyncHandler(async (req, res) => {
  const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId.trim() : '';
  if (!isValidUuid(documentId)) {
    return res.status(400).json({ error: 'documentId is required so practice content can be grounded in your chapter.' });
  }

  await requireDocumentAccess(req.user,documentId);
  let resolved;
  try {
    resolved = await resolveChapterForDocument(documentId, req.user.schoolId);
  } catch (err) {
    console.warn('[practice] grounding failed:', err.message);
    return res.status(502).json({ error: 'That chapter is not ready yet. Try again in a moment.' });
  }
  if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);

  const { chapter, chunks, chapterKey } = resolved;
  if (!chunks.length) {
    return res.status(422).json({ error: 'There is not enough readable text in this chapter yet to build practice content from.' });
  }

  const contentFingerprint = chapter.contentFingerprint || '';

  const conceptPriority = await resolveConceptPriority({
    studentId: req.user.userId,
    schoolId: req.user.schoolId,
  });
  const support = await loadAcademicSupport({ studentId: req.user.userId, schoolId: req.user.schoolId,
    url: PSV_SERVICE_URL, token: INTERNAL_SERVICE_TOKEN });
  chapter.academicSupport = supportForChapter(chapter, support);
  const targetingFingerprint = createHash('sha256').update(JSON.stringify({
    legacy: targetingFingerprintFor(conceptPriority), academic: chapter.academicSupport,
  })).digest('hex');

  // Same-student dedupe only — nothing generated for one student is ever
  // served to another. With no human reviewing this content, that absence of
  // fan-out is what keeps instant generation safe.
  //
  // targetingFingerprint is part of the identity, not just the payload: a set
  // built before this student developed a weak area is not a valid cache hit
  // for one built to target it, even though chapter and content are identical.
  const cached = await prisma.practiceSet.findFirst({
    where: { studentId: req.user.userId, chapterKey, contentFingerprint, targetingFingerprint, status: 'done' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (cached) {
    return res.status(200).json({ practiceSetId: cached.id, status: cached.status });
  }

  const set = await prisma.$transaction(async tx => {
  const set = await tx.practiceSet.create({
    data: {
      studentId: req.user.userId,
      schoolId: req.user.schoolId,
      status: 'queued',
      chapterKey,
      contentFingerprint,
      targetingFingerprint,
      // Persisted rather than discarded (it was already resolved for
      // grounding): this is what lets a weak area derived from an attempt on
      // this set name the documents it came from, which is the precondition
      // for that area being card-eligible in services/discover.
      documentIds: Array.isArray(chapter.documentIds)
        ? chapter.documentIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()).slice(0, 8)
        : [],
    },
    select: { id: true, status: true },
  });
    await generationQueue.enqueue(tx, set.id, {kind:'practice', groundingContext:{chapter,chunks,conceptPriority}});
    return set;
  });

  res.status(202).json({ practiceSetId: set.id, status: set.status });
}));

/**
 * Does an active/complete practice set already exist for this lesson?
 *
 * The frontend calls this on lesson-open and on refresh so the mandatory-quiz
 * gate is always re-derived from the server, never trusted from client memory
 * that a page reload would lose.
 */
app.get('/api/practice', ...studentOnly, asyncHandler(async (req, res) => {
  const documentId = typeof req.query?.documentId === 'string' ? req.query.documentId.trim() : '';
  if (!isValidUuid(documentId)) {
    return res.status(400).json({ error: 'documentId is required.' });
  }

  await requireDocumentAccess(req.user,documentId);
  let resolved;
  try {
    resolved = await resolveChapterForDocument(documentId, req.user.schoolId);
  } catch (err) {
    console.warn('[practice] grounding failed:', err.message);
    return res.status(502).json({ error: 'That chapter is not ready yet. Try again in a moment.' });
  }
  if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);

  const { chapter, chapterKey } = resolved;
  const set = await prisma.practiceSet.findFirst({
    where: { studentId: req.user.userId, chapterKey, contentFingerprint: chapter.contentFingerprint || '' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });

  if (!set) {
    return res.status(200).json({ practiceSetId: null, status: null, complete: false });
  }

  const attempt = await prisma.practiceAttempt.findFirst({
    where: { practiceSetId: set.id, studentId: req.user.userId, completedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  res.status(200).json({ practiceSetId: set.id, status: set.status, complete: Boolean(attempt) });
}));

/**
 * Cards due for spaced-repetition review, plus never-reviewed cards to fill
 * out the queue. Deterministic — no LLM in this path (services/practice/
 * scheduler.js is pure), per CLAUDE.md's hard rule on scoring/routing/
 * learner-state paths. Registered above GET /api/practice/:setId so the
 * literal "review" segment can never be swallowed as a setId — though in
 * practice the two-segment shape here never collides with that one-segment
 * route anyway.
 */
app.get('/api/practice/review/due', ...studentOnly, asyncHandler(async (req, res) => {
  const rawLimit = Number.parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const now = new Date();

  const allowedDocuments = await accessibleDocumentIds(req.user);
  const [states, sets] = await Promise.all([
    prisma.flashcardReviewState.findMany({
      where: { studentId: req.user.userId },
      select: { practiceSetId: true, cardId: true, dueAt: true },
    }),
    prisma.practiceSet.findMany({
      where: { studentId: req.user.userId, schoolId: req.user.schoolId, status: 'done', documentIds: { hasSome: [...allowedDocuments] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, chapterKey: true, flashcards: true },
    }),
  ]);

  const setsById = new Map(sets.map(set => [set.id, set]));
  const seenCardKeys = new Set(states.map(state => `${state.practiceSetId}:${state.cardId}`));

  const cardFrom = (setId, cardId) => {
    const set = setsById.get(setId);
    const card = Array.isArray(set?.flashcards) ? set.flashcards.find(c => c.id === cardId) : null;
    if (!card) return null;
    return {
      practiceSetId: set.id,
      cardId: card.id,
      front: card.front,
      back: card.back,
      conceptId: card.conceptId || null,
      chapterKey: set.chapterKey,
    };
  };

  const dueCards = states
    .filter(state => state.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit)
    .map(state => {
      const card = cardFrom(state.practiceSetId, state.cardId);
      // The owning set may have been regenerated since this state row was
      // written — cardId is only unique within one PracticeSet's flashcards
      // JSON, so a stale row simply no longer resolves. Skip rather than error.
      return card && { ...card, dueAt: state.dueAt.toISOString(), isNew: false };
    })
    .filter(Boolean);

  const newCards = [];
  const remaining = limit - dueCards.length;
  outer: for (const set of remaining > 0 ? sets : []) {
    if (!Array.isArray(set.flashcards)) continue;
    for (const card of set.flashcards) {
      const key = `${set.id}:${card.id}`;
      if (seenCardKeys.has(key)) continue;
      newCards.push({
        practiceSetId: set.id, cardId: card.id, front: card.front, back: card.back,
        conceptId: card.conceptId || null, chapterKey: set.chapterKey, dueAt: null, isNew: true,
      });
      if (newCards.length >= remaining) break outer;
    }
  }

  res.status(200).json({ cards: [...dueCards, ...newCards], dueCount: dueCards.length, newCount: newCards.length });
}));

app.post('/api/practice/review/grade', ...studentOnly, asyncHandler(async (req, res) => {
  const practiceSetId = typeof req.body?.practiceSetId === 'string' ? req.body.practiceSetId.trim() : '';
  const cardId = typeof req.body?.cardId === 'string' ? req.body.cardId.trim() : '';
  const grade = typeof req.body?.grade === 'string' ? req.body.grade.trim() : '';

  if (!isValidUuid(practiceSetId)) {
    return res.status(400).json({ error: 'practiceSetId is required.' });
  }
  if (!GRADES.includes(grade)) {
    return res.status(400).json({ error: `grade must be one of ${GRADES.join(', ')}.` });
  }

  const set = await prisma.practiceSet.findFirst({
    where: { id: practiceSetId, studentId: req.user.userId, status: 'done' },
    select: { id: true, schoolId: true, flashcards: true, documentIds: true },
  });
  if (!set) return res.status(404).json({ error: 'Practice set not found.' });
  await requireDocumentAccess(req.user,set.documentIds?.[0]);

  const card = Array.isArray(set.flashcards) ? set.flashcards.find(c => c.id === cardId) : null;
  if (!card) return res.status(404).json({ error: 'Flashcard not found in this practice set.' });

  const existing = await prisma.flashcardReviewState.findUnique({
    where: { studentPracticeCardIdentity: { studentId: req.user.userId, practiceSetId, cardId } },
    select: { repetitions: true, intervalDays: true, easeFactor: true, lapses: true },
  });

  const now = new Date();
  const next = gradeReview(existing || initialState(), grade, now);

  await prisma.$transaction(async tx => {
  await tx.flashcardReviewState.upsert({
    where: { studentPracticeCardIdentity: { studentId: req.user.userId, practiceSetId, cardId } },
    create: {
      studentId: req.user.userId,
      schoolId: set.schoolId,
      practiceSetId,
      cardId,
      repetitions: next.repetitions,
      intervalDays: next.intervalDays,
      easeFactor: next.easeFactor,
      lapses: next.lapses,
      dueAt: next.dueAt,
      lastReviewedAt: next.lastReviewedAt,
    },
    update: {
      repetitions: next.repetitions,
      intervalDays: next.intervalDays,
      easeFactor: next.easeFactor,
      lapses: next.lapses,
      dueAt: next.dueAt,
      lastReviewedAt: next.lastReviewedAt,
    },
  });

  const cardConceptId = card.conceptId || null;
  await enqueueEvidence(tx, cardConceptId ? [{
      eventId: stableEvidenceEventId('flashcard', req.user.userId, practiceSetId, cardId, now.toISOString()),
      schemaVersion: 1,
      studentId: req.user.userId,
      schoolId: req.user.schoolId,
      sessionId: `flashcard-review:${practiceSetId}`,
      itemId: cardId,
      conceptId: cardConceptId,
      clientTsMono: 0,
      clientTsWall: now.toISOString(),
      source: 'flashcard',
      eventType: 'flashcard_review_completed',
      payload: {
        grade,
        conceptLabel: card.conceptTag || 'Assessed concept',
        resultRef: `flashcard-review:${practiceSetId}:${cardId}`,
        evidenceClass: 'self_report',
      },
    }] : []);
  });
  const remainingDueCount = await prisma.flashcardReviewState.count({
    where: { studentId: req.user.userId, dueAt: { lte: now } },
  });

  res.status(200).json({
    cardId,
    grade,
    dueAt: next.dueAt.toISOString(),
    intervalDays: next.intervalDays,
    remainingDueCount,
  });
}));

app.get('/api/practice/:setId', ...studentOnly, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.setId)) {
    return res.status(404).json({ error: 'Practice set not found.' });
  }

  const set = await prisma.practiceSet.findFirst({
    where: { id: req.params.setId, studentId: req.user.userId },
    select: {
      id: true, status: true, summary: true, flashcards: true, quiz: true,
      provenance: true, failureReason: true, createdAt: true, documentIds: true,
    },
  });
  if (!set) return res.status(404).json({ error: 'Practice set not found.' });
  await requireDocumentAccess(req.user,set.documentIds?.[0]);

  const base = { practiceSetId: set.id, status: set.status, createdAt: set.createdAt };
  if (set.status !== 'done') {
    return res.status(200).json({ ...base, failureReason: set.failureReason || null });
  }

  // The answer key is withheld until submission — sending correctAnswer and
  // explanation up front would let a student read them in devtools before
  // answering.
  const quiz = Array.isArray(set.quiz)
    ? set.quiz.map(question => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options,
      conceptId: question.conceptId || null,
    }))
    : [];

  const support = await loadAcademicSupport({ studentId: req.user.userId, schoolId: req.user.schoolId,
    url: PSV_SERVICE_URL, token: INTERNAL_SERVICE_TOKEN });
  const ids = new Set([...quiz, ...(set.flashcards || [])].map(item => item.conceptId));
  res.status(200).json({
    ...base, summary: set.summary,
    flashcards: orderPractice(set.flashcards || [], support),
    quiz: orderPractice(quiz, support), provenance: set.provenance,
    learningSupport: support.filter(row => ids.has(row.conceptId)),
  });
}));

app.post('/api/practice/:setId/attempt', ...studentOnly, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.setId)) {
    return res.status(404).json({ error: 'Practice set not found.' });
  }

  const set = await prisma.practiceSet.findFirst({
    where: { id: req.params.setId, studentId: req.user.userId, status: 'done' },
    select: { id: true, schoolId: true, quiz: true, documentIds: true },
  });
  if (!set) return res.status(404).json({ error: 'Practice set not found.' });
  await requireDocumentAccess(req.user,set.documentIds?.[0]);

  const rawAnswers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const flashcardsReviewed = req.body?.flashcardsReviewed === true;

  const graded = gradePracticeAttempt(set.quiz, rawAnswers);
  const allAnswered = graded.results.every(item => typeof item.studentAnswer === 'string' && item.studentAnswer);
  const complete = flashcardsReviewed && allAnswered;

  const attempt = await prisma.$transaction(async tx => {
  const saved = await tx.practiceAttempt.create({
    data: {
      practiceSetId: set.id,
      studentId: req.user.userId,
      schoolId: req.user.schoolId,
      answers: graded.answers,
      result: { results: graded.results, weakAreas: graded.weakAreas, score: graded.score, maxScore: graded.maxScore, percentage: graded.percentage },
      flashcardsReviewedAt: flashcardsReviewed ? new Date() : null,
      completedAt: complete ? new Date() : null,
    },
    select: { id: true },
  });

  await enqueueEvidence(tx, graded.results.filter(result => result.conceptId).map(result => ({
      eventId: stableEvidenceEventId('practice', saved.id, result.questionId, 'outcome'),
      schemaVersion: 1,
      studentId: req.user.userId,
      schoolId: req.user.schoolId,
      sessionId: `practice:${saved.id}`,
      itemId: result.questionId,
      conceptId: result.conceptId,
      clientTsMono: 0,
      clientTsWall: new Date().toISOString(),
      source: 'practice',
      eventType: 'answer_submitted',
      payload: {
        correct: result.correct,
        conceptLabel: result.conceptTag,
        scoreNormalized: result.correct ? 1 : 0,
        questionType: 'mcq',
        resultRef: `practice-attempt:${saved.id}`,
        misconceptionIds: result.correct ? [] : result.misconceptionIds,
        gradingAuthority: 'practice-service',
      },
    })));
  return saved;
  });

  if (complete) {
    fireAnalyticsEvent({
      type: 'practice_completed',
      studentId: req.user.userId,
      schoolId: req.user.schoolId,
      metadata: {
        practiceSetId: set.id,
        attemptId: attempt.id,
        score: graded.score,
        maxScore: graded.maxScore,
        percentage: graded.percentage,
        weakAreas: graded.weakAreas.map(item => item.label),
      },
    });
  }

  res.status(200).json({
    result: { results: graded.results, score: graded.score, maxScore: graded.maxScore, percentage: graded.percentage },
    weakAreas: graded.weakAreas,
    complete,
  });
}));

/**
 * Cross-service read for the tutor chat's personalization prompt.
 *
 * Internal-token-gated, no teacher fallback — same posture as services/ai's
 * chat-insights route: a teacher-reachable view over a named student's
 * practice history is out of scope until services/privacy exists.
 */
app.get('/api/practice/internal/student-learning-context', requireInternalToken, asyncHandler(async (req, res) => {
  let where;
  try {
    where = buildStudentAttemptWhere(req.query || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Concurrent, not sequential — see the same note on quiz's copy of this
  // route. fetchCardOutcomes fails soft to [], so Discover being unreachable
  // degrades this context rather than breaking it.
  const [attempts, cardOutcomes] = await Promise.all([
    prisma.practiceAttempt.findMany({
      where,
      orderBy: { completedAt: 'desc' },
      take: 10,
      select: {
        completedAt: true,
        result: true,
        // Names which RAG documents produced this weak area, which is what
        // makes it card-eligible in Discover (Q2: practice from day one).
        practiceSet: { select: { documentIds: true } },
      },
    }),
    fetchCardOutcomes({ studentId: where.studentId }),
  ]);

  res.status(200).json(buildPracticeLearningContext(attempts, cardOutcomes));
}));

/**
 * Generate one practice set. The grounding context is passed in rather than
 * re-fetched, the same reasoning as the visuals job: the route already paid
 * for the RAG round-trip and re-reading it here would let the chapter shift
 * between the cache key being computed and the spec being built.
 */
async function processPracticeJob(setId, { chapter, chunks, conceptPriority = [] }) {
  const claimed = await prisma.practiceSet.updateMany({
    where: { id: setId, status: 'queued' },
    data: { status: 'processing', failureReason: null },
  });
  if (claimed.count !== 1) return;

  const set = await prisma.practiceSet.findUnique({
    where: { id: setId },
    select: { id: true, studentId: true, schoolId: true },
  });
  if (!set) return;

  try {
    const { spec, model, provider, conceptPriorityCoverage } = await generatePracticeSet({
      chapter,
      chunks,
      conceptPriority,
    });

    const textSafety = validateGeneratedTextSafety(collectPracticeSetText(spec));
    if (!textSafety.allowed) {
      throw new Error('The generated practice content did not pass the safety check.');
    }

    await prisma.practiceSet.update({
      where: { id: setId },
      data: {
        status: 'done',
        summary: spec.summary,
        flashcards: spec.flashcards,
        quiz: spec.quiz,
        provenance: buildProvenance(chapter, chunks),
        model: model ? String(model).slice(0, 80) : null,
        provider: provider ? String(provider).slice(0, 24) : null,
        failureReason: null,
      },
    });

    fireAnalyticsEvent({
      type: 'practice_generated',
      studentId: set.studentId,
      schoolId: set.schoolId,
      subject: chapter.subject,
      metadata: {
        chapterNumber: chapter.chapterNumber,
        chapterName: chapter.chapterName,
        flashcardCount: spec.flashcards.length,
        quizQuestionCount: spec.quiz.length,
        provider: provider || null,
        // Observability for targeting, never a gate: how many concepts were
        // asked for, and how many generated items actually landed on one.
        conceptPriorityCount: conceptPriority.length,
        conceptPriorityCoverage,
      },
    });
  } catch (err) {
    console.warn(`[practice] set ${setId} generation failed:`, err.message);
    await prisma.practiceSet.update({
      where: { id: setId },
      data: { status: 'failed', failureReason: buildPracticeFailureReason(err) },
    }).catch(updateErr => {
      console.error(`[practice] could not mark set ${setId} failed:`, updateErr.message);
    });
  }
}

/**
 * A failure reason a student can read. The raw error can carry a provider
 * name, an HTTP body, or an env var name — replaced rather than truncated.
 */
function buildPracticeFailureReason(err) {
  const raw = String(err?.message || '');
  if (/quota|429|rate limit|too_many_requests/i.test(raw)) {
    return 'The practice service is busy right now. Please try again in a minute.';
  }
  if (/safety check/i.test(raw)) {
    return 'That chapter could not be turned into safe practice content.';
  }
  if (/failed validation after/i.test(raw)) {
    return 'Practice content could not be built cleanly from this chapter. Try again in a moment.';
  }
  if (/not enough|no usable/i.test(raw)) {
    return 'There is not enough readable text in this chapter yet to build practice content from.';
  }
  return 'Practice content could not be generated. Please try again later.';
}

function fireAnalyticsEvent(event) {
  if (!ANALYTICS_URL || !INTERNAL_SERVICE_TOKEN) return;
  fetch(`${ANALYTICS_URL.replace(/\/+$/, '')}/api/analytics/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
    },
    body: JSON.stringify(event),
  }).catch(err => {
    console.warn('[practice] analytics event failed:', err.message);
  });
}

function stableEvidenceEventId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 48);
  return `${namespace}:${digest}`;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.use((err, _req, res, _next) => {
  console.error('[practice] unhandled error:', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

async function shutdown(signal) {
  console.log(`[practice] ${signal} received. Shutting down...`);
  await Promise.allSettled([...backgroundTasks]);
  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  startEvidenceWorker(prisma, { url: PSV_SERVICE_URL, token: INTERNAL_SERVICE_TOKEN });
  const server = app.listen(PORT, () => {
    console.log(`[practice] Service running on :${PORT}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[practice] Port ${PORT} is already in use.`);
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A stray throw outside the request path would otherwise crash the
  // process silently under Node's default behavior, taking down every
  // concurrently in-flight request with it — worst at peak load. Log with
  // full context and exit so the container's `restart: unless-stopped`
  // policy brings it back.
  process.on('uncaughtException', err => {
    console.error('[practice] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    console.error('[practice] unhandledRejection:', reason);
    process.exit(1);
  });
}

module.exports = app;

async function processQueuedGeneration(payload, id) {
    const row = await prisma.practiceSet.findUnique({where:{id}});
    if (!row || row.status === 'done') return;
    await prisma.practiceSet.update({where:{id},data:{status:'queued'}});
    await processPracticeJob(id,payload.groundingContext);
    const result = await prisma.practiceSet.findUnique({where:{id}});
    if (result.status !== 'done') throw new Error(result.failureReason || 'Practice generation failed');
  }

if (process.env.GENERATION_WORKER === 'true') {
  generationQueue.start(processQueuedGeneration).catch(error => {console.error(error);process.exit(1)});
  process.on('SIGTERM',()=>generationQueue.stop());
}
