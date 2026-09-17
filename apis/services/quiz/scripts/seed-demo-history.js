'use strict';

/**
 * Seeds demo quiz attempts.
 *
 * Writes only into `quiz_db`. Attempts are graded by the real
 * `gradeQuizAttempt`, so an attempt's stored `weakAreas` and the `weakAreas`
 * the analytics seeder later puts on its `quiz_submitted` event come from one
 * computation and cannot disagree — which is what makes the teacher
 * dashboard's weak-area card survive a drill-down.
 *
 * This never fabricates Quiz or QuizQuestion rows. Questions are LLM-drafted
 * and sit behind a human approval gate precisely because nothing can verify an
 * answer key automatically; a seeder minting them would route around that gate.
 * If no quiz exists to attempt, this exits cleanly and says so.
 *
 * Run:   node scripts/seed-demo-history.js
 * Purge: node scripts/seed-demo-history.js --purge
 */

const { PrismaClient } = require('@prisma/client');

const { demoId } = require('/app/seed-data/demo-history/lib/demo-ids');
const { buildDemoPlan, loadPlan } = require('/app/seed-data/demo-history/lib/demo-plan');
const { loadDemoCorpus } = require('/app/seed-data/demo-history/lib/demo-corpus');
const { gradeQuizAttempt } = require('../lib/scoring');
const { QUIZ_STATUS } = require('../lib/quiz-status');

const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3001';
const QUIZ_SELF_URL = process.env.QUIZ_SELF_URL || 'http://quiz:3005';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const TEACHER_EMAIL = process.env.DEMO_TEACHER_EMAIL || 'teacher@demo.com';
const PURGE = process.argv.includes('--purge');

function assertSafeToRun() {
  if (process.env.SEED_DEMO_HISTORY !== 'true') {
    console.log('[demo-history:quiz] SEED_DEMO_HISTORY is not "true" — nothing to do.');
    return false;
  }
  if (!process.env.DEMO_SCHOOL_ID) {
    throw new Error('DEMO_SCHOOL_ID is required; refusing to seed an unscoped school.');
  }
  return true;
}

async function login(email) {
  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `Refusing to seed: ${email} did not authenticate with the demo password ` +
      `(HTTP ${response.status}). This account is not a demo account.`
    );
  }
  const setCookie = response.headers.get('set-cookie') || '';
  const jwt = /jwt=([^;]+)/.exec(setCookie)?.[1] || null;
  return { body: await response.json(), jwt };
}

/**
 * Approve a pending quiz through the real endpoint.
 *
 * Deliberately over HTTP rather than a direct status update: `approvedBy` and
 * `approvedAt` are the audit trail saying a named human vouched for these
 * answer keys, and the seeder has no business forging that. The real gate
 * writes it or it does not get written.
 */
async function approveViaGate(quizId) {
  const teacher = await login(TEACHER_EMAIL);
  if (!teacher.jwt) throw new Error('Teacher login returned no jwt cookie.');

  const response = await fetch(
    `${QUIZ_SELF_URL}/api/quiz/quizzes/${encodeURIComponent(quizId)}/approve`,
    { method: 'POST', headers: { Cookie: `jwt=${teacher.jwt}` } }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Approval failed (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Find a quiz to attempt, approving one if only drafts exist.
 * Returns null when there is genuinely nothing — a skip, not a failure.
 */
/**
 * The approved quiz for one specific bound chapter, if there is one.
 *
 * Attempts used to be graded against whatever single quiz existed school-wide,
 * so an attempt's weak areas had no relationship to the chapter the analytics
 * event named. Now that sessions bind to real chapters there is a real
 * `ChapterQuizSource` to look through, and the two can agree. Falls back to the
 * school-wide pick, which is still better than seeding nothing.
 */
async function resolveQuizForChapter(schoolId, chapter) {
  const source = await prisma.chapterQuizSource.findFirst({
    where: {
      schoolId,
      subject: chapter.subject,
      grade: chapter.grade,
      chapterNumber: chapter.chapterNumber,
    },
    select: { activeQuizId: true },
  });
  if (!source || !source.activeQuizId) return null;

  const quiz = await prisma.quiz.findFirst({
    where: { id: source.activeQuizId, status: QUIZ_STATUS.READY },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  return (quiz && (quiz.questions || []).length) ? quiz : null;
}

async function resolveQuiz(schoolId) {
  const ready = await prisma.quiz.findFirst({
    where: { schoolId, status: QUIZ_STATUS.READY },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  if (ready) return ready;

  const pending = await prisma.quiz.findFirst({
    where: { schoolId, status: QUIZ_STATUS.PENDING_REVIEW },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true },
  });
  if (!pending) return null;

  console.log(`[demo-history:quiz] Approving "${pending.title}" through the teacher gate...`);
  await approveViaGate(pending.id);

  return prisma.quiz.findUnique({
    where: { id: pending.id },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
}

/**
 * Build answers that land near a target percentage.
 *
 * The first N questions are answered correctly and the rest wrong, so the
 * resulting weak areas are the genuine `weakAreaLabel`s of questions this
 * student actually got wrong — not a list invented alongside a score.
 */
function answersForTarget(quiz, targetPercent) {
  const questions = quiz.questions || [];
  const totalMarks = questions.reduce((sum, q) => sum + Number(q.marks || 1), 0);
  const targetMarks = (targetPercent / 100) * totalMarks;

  const answers = {};
  let earned = 0;
  for (const question of questions) {
    const marks = Number(question.marks || 1);
    if (earned + marks <= targetMarks) {
      answers[question.id] = question.correctAnswer;
      earned += marks;
    } else {
      // A definitely-wrong answer: for MCQ pick a non-correct option, else text.
      const options = Array.isArray(question.options) ? question.options : [];
      const wrong = options.find(option => option !== question.correctAnswer);
      answers[question.id] = wrong !== undefined ? wrong : 'not sure';
    }
  }
  return answers;
}

async function seedAttempts(quizForAttempt, studentPlan, studentId, schoolId) {
  let written = 0;
  for (const attempt of studentPlan.attempts) {
    const quiz = await quizForAttempt(attempt);
    if (!quiz) continue;

    const answers = answersForTarget(quiz, attempt.scorePercent);
    const result = gradeQuizAttempt(quiz, answers);

    await prisma.quizAttempt.upsert({
      where: { id: attempt.id },
      create: {
        id: attempt.id,
        quizId: quiz.id,
        sourceId: quiz.sourceId,
        schoolId,
        studentId,
        answers,
        result,
        score: result.score,
        maxScore: result.maxScore,
        percentage: result.percentage,
        submittedAt: attempt.at,
        createdAt: attempt.at,
      },
      update: {
        answers,
        result,
        score: result.score,
        maxScore: result.maxScore,
        percentage: result.percentage,
        submittedAt: attempt.at,
      },
    });
    written += 1;
  }
  return written;
}

async function main() {
  if (!assertSafeToRun()) return;

  const schoolId = process.env.DEMO_SCHOOL_ID;
  const fixture = loadPlan();
  const corpus = await loadDemoCorpus(fixture, { label: 'demo-history:quiz' });
  if (corpus.skip) return;

  const plan = buildDemoPlan({ plan: fixture, now: new Date(), chapters: corpus.chapters });
  for (const warning of plan.warnings) console.warn(`[demo-history:quiz] ${warning}`);

  const students = [];
  for (const studentPlan of plan.students) {
    const { body } = await login(studentPlan.persona.email);
    if (body.role !== 'student') {
      throw new Error(`Refusing to seed: ${studentPlan.persona.email} is a ${body.role}.`);
    }
    students.push({ email: studentPlan.persona.email, studentId: body.userId, studentPlan });
  }

  if (PURGE) {
    for (const student of students) {
      const ids = student.studentPlan.attempts.map(a => a.id);
      const { count } = await prisma.quizAttempt.deleteMany({ where: { id: { in: ids } } });
      console.log(`[demo-history:quiz] Purged ${count} attempts for ${student.email}`);
    }
    return;
  }

  const fallbackQuiz = await resolveQuiz(schoolId);
  if (!fallbackQuiz || !(fallbackQuiz.questions || []).length) {
    console.warn(
      '[demo-history:quiz] No approved quiz with questions exists for the demo school, ' +
      'so there is nothing to attempt. Upload a chapter PDF and let generation run, ' +
      'then re-run this job. Skipping without error.'
    );
    return;
  }

  // Prefer the quiz belonging to the chapter the attempt claims to be about, so
  // an attempt's weak areas and the analytics event naming that chapter are one
  // and the same thing. Cached: three students share the same few chapters.
  const quizCache = new Map();
  const quizForAttempt = async attempt => {
    if (!quizCache.has(attempt.chapterKey)) {
      quizCache.set(attempt.chapterKey, await resolveQuizForChapter(schoolId, attempt));
    }
    return quizCache.get(attempt.chapterKey) || fallbackQuiz;
  };

  for (const student of students) {
    const written = await seedAttempts(quizForAttempt, student.studentPlan, student.studentId, schoolId);
    const scores = student.studentPlan.attempts.map(a => a.scorePercent).join(', ');
    console.log(`[demo-history:quiz] ${student.email}: ${written} attempts (targets ${scores}%)`);
  }

  const matched = [...quizCache.values()].filter(Boolean).length;
  console.log(
    `[demo-history:quiz] ${matched}/${quizCache.size} bound chapters had their own approved quiz; ` +
    'the rest fell back to the school-wide quiz.'
  );

  console.log('[demo-history:quiz] Complete.');
}

main()
  .catch(error => {
    console.error('[demo-history:quiz] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
