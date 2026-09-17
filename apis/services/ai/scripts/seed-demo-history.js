'use strict';

/**
 * Seeds demo tutor history, onboarding, and Discover personalisation.
 *
 * Writes only into `ai_db` — the schema this service owns. The quiz and
 * analytics seeders write theirs, and the three agree on ids by deriving them
 * from the same inputs rather than by talking to each other.
 *
 * Run:   node scripts/seed-demo-history.js
 * Purge: node scripts/seed-demo-history.js --purge
 */

const { PrismaClient } = require('@prisma/client');

const { demoId, dayAt } = require('/app/seed-data/demo-history/lib/demo-ids');
const { buildDemoPlan, loadPlan } = require('/app/seed-data/demo-history/lib/demo-plan');
const { loadDemoCorpus, loadChapterQa } = require('/app/seed-data/demo-history/lib/demo-corpus');
const { DEFAULT_QUESTIONS, buildFallbackProfile, formatProfileForPrompt } = require('../onboarding');
const { applySignal, rebuildProfile } = require('../interest-store');
const { refreshStudentNews } = require('../student-news');

const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3001';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const PURGE = process.argv.includes('--purge');

/* ── Locks ──────────────────────────────────────────────────────────────────
   Four independent gates. Any one of them alone is enough to stop this
   running against a real school, because synthetic history in a real teacher's
   dashboard is indistinguishable from fraud once it is there.            ── */
function assertSafeToRun() {
  if (process.env.SEED_DEMO_HISTORY !== 'true') {
    console.log('[demo-history:ai] SEED_DEMO_HISTORY is not "true" — nothing to do.');
    return false;
  }
  if (!process.env.DEMO_SCHOOL_ID) {
    throw new Error('DEMO_SCHOOL_ID is required; refusing to seed an unscoped school.');
  }
  return true;
}

/**
 * Resolve each demo student's id by logging in as them.
 *
 * This is the load-bearing lock: it proves the account is a demo account by
 * proving it still has the demo password. An account belonging to a real child
 * will not authenticate, so this cannot write history onto them even if every
 * other gate were misconfigured.
 */
async function resolveStudents(personas) {
  const resolved = [];
  for (const persona of personas) {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: persona.email, password: DEMO_PASSWORD }),
    });
    if (!response.ok) {
      throw new Error(
        `Refusing to seed: ${persona.email} did not authenticate with the demo password ` +
        `(HTTP ${response.status}). This account is not a demo account.`
      );
    }
    const body = await response.json();
    if (body.role !== 'student') {
      throw new Error(`Refusing to seed: ${persona.email} is a ${body.role}, not a student.`);
    }
    resolved.push({ ...persona, studentId: body.userId });
  }
  return resolved;
}

function demoAnswersFor(persona) {
  // Deterministic answers that reflect the persona, shaped to the real
  // question set so the profile builder produces a genuine profile.
  const byPersona = {
    'arjun@demo.com': {
      interests: ['Space and technology', 'Games'],
      examples: ['Technology and gadgets'],
      explanation_style: ['Step by step'],
      pace: 'Steady',
      challenge: 'Start easy and build up',
      interaction: 'Ask one quick check question',
      motivation: ['Understanding how things work'],
      dislikes: ['Long paragraphs'],
      confidence: 'Give me a hint first',
      goals: 'Get better at science reasoning',
    },
    'priya@demo.com': {
      interests: ['Animals and nature', 'Drawing and making things'],
      examples: ['Everyday life'],
      explanation_style: ['With a diagram', 'Step by step'],
      pace: 'Steady',
      challenge: 'Give me the hard one first',
      interaction: 'Ask one quick check question',
      motivation: ['Doing well in tests'],
      dislikes: ['Too many numbers at once'],
      confidence: 'Give me a hint first',
      goals: 'Understand biology deeply',
    },
    'rahul@demo.com': {
      interests: ['Sports', 'Games'],
      examples: ['Sport and games'],
      explanation_style: ['Short and simple'],
      pace: 'Slow and careful',
      challenge: 'Start easy and build up',
      interaction: 'Just explain it fully',
      motivation: ['Keeping up with class'],
      dislikes: ['Long paragraphs', 'Too many numbers at once'],
      confidence: 'Give me a hint first',
      goals: 'Stop losing marks in maths',
    },
  };
  return byPersona[persona.email] || byPersona['arjun@demo.com'];
}

async function seedOnboarding(student, now) {
  const answers = demoAnswersFor(student);
  const profile = buildFallbackProfile(answers);
  const completedAt = dayAt(29, now);

  await prisma.studentOnboarding.upsert({
    where: { studentId: student.studentId },
    create: {
      id: demoId(student.email, 'onboarding'),
      studentId: student.studentId,
      schoolId: process.env.DEMO_SCHOOL_ID,
      status: 'completed',
      questionSource: 'fallback',
      questions: DEFAULT_QUESTIONS,
      answers,
      startedAt: completedAt,
      completedAt,
    },
    update: { status: 'completed', answers, completedAt },
  });

  await prisma.studentLearningProfile.upsert({
    where: { studentId: student.studentId },
    create: {
      id: demoId(student.email, 'learning-profile'),
      studentId: student.studentId,
      schoolId: process.env.DEMO_SCHOOL_ID,
      profile,
      promptContext: formatProfileForPrompt(profile),
      source: 'demo_seed',
    },
    update: { profile, promptContext: formatProfileForPrompt(profile) },
  });
}

/**
 * Chat sessions.
 *
 * `board` and `curriculum` are not decoration. `GET /api/ai/chat/sessions`
 * turns whatever the client sends into hard Prisma equality filters, and the
 * frontend always sends the selected lesson's board and curriculum. A session
 * row with them NULL therefore matches nothing and is dropped in SQL, before
 * any client-side chapter matching runs — the whole seeded history is invisible
 * in the app while looking perfectly present in the database. The live chat
 * route persists both (`server.js`, via `...lessonContext.data`); this seeder
 * used not to, and that was the deviation.
 *
 * The update branch rewrites the lesson context rather than only `createdAt`.
 * Session ids derive from (email, 'session', dayOffset) with no chapter in
 * them, so a re-seed against a re-ingested corpus resolves to the same row —
 * which means a narrowed update would silently leave a stale chapter name on
 * an id that still looks correct.
 */
async function seedChat(studentPlan, student) {
  for (const session of studentPlan.sessions) {
    const lessonContext = {
      subject: session.subject,
      grade: session.grade,
      board: session.board,
      curriculum: session.curriculum,
      chapterNumber: session.chapterNumber,
      chapterName: session.chapterName,
    };
    await prisma.chatSession.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        studentId: student.studentId,
        schoolId: process.env.DEMO_SCHOOL_ID,
        ...lessonContext,
        createdAt: session.at,
      },
      update: { ...lessonContext, createdAt: session.at },
    });
  }

  for (const turn of studentPlan.turns) {
    // A minute after the question, so ordering within a turn is stable.
    const answeredAt = new Date(turn.at.getTime() + 60 * 1000);

    await prisma.message.upsert({
      where: { id: turn.userMessageId },
      create: {
        id: turn.userMessageId,
        sessionId: turn.sessionId,
        role: 'user',
        content: turn.question,
        createdAt: turn.at,
      },
      update: { content: turn.question, createdAt: turn.at },
    });
    await prisma.message.upsert({
      where: { id: turn.assistantMessageId },
      create: {
        id: turn.assistantMessageId,
        sessionId: turn.sessionId,
        role: 'assistant',
        content: turn.answer,
        createdAt: answeredAt,
      },
      // `createdAt` must be rewritten here too. Omitting it re-seeds the user
      // message onto a new timestamp while its answer keeps the old one, and
      // since history is ordered by `createdAt` the whole thread interleaves
      // wrongly — every reply appearing before the question that prompted it.
      update: { content: turn.answer, createdAt: answeredAt },
    });
  }
}

/**
 * Discover personalisation.
 *
 * Articles expire, so signals cannot reference a static fixture — the live
 * pool has to exist first. If it does not and cannot be refreshed, this is
 * skipped rather than failed: a demo without a personalised feed is worse
 * than one without, but a stack that will not boot is worse than both.
 */
async function seedNewsSignals(studentPlan, student, now) {
  let articles = await prisma.studentNewsArticle.findMany({
    where: { safetyStatus: 'approved', expiresAt: { gt: now } },
    select: { id: true, title: true, summary: true, category: true, topics: true, entities: true },
    take: 200,
  });

  if (!articles.length) {
    console.log('[demo-history:ai] No news articles present; refreshing feed first...');
    try {
      await refreshStudentNews({ prisma });
      articles = await prisma.studentNewsArticle.findMany({
        where: { safetyStatus: 'approved', expiresAt: { gt: now } },
        select: { id: true, title: true, summary: true, category: true, topics: true, entities: true },
        take: 200,
      });
    } catch (error) {
      console.warn('[demo-history:ai] News refresh failed:', error.message);
    }
  }

  if (!articles.length) {
    console.warn('[demo-history:ai] Still no articles — skipping Discover personalisation.');
    return 0;
  }

  let applied = 0;
  for (const signal of studentPlan.newsSignals) {
    try {
      // Prefer an article in this persona's category so the graphs diverge
      // visibly between students; fall back to anything rather than skipping.
      const pool = articles.filter(a => String(a.category).toLowerCase() === signal.category);
      const chosen = (pool.length ? pool : articles)[signal.dayOffset % (pool.length || articles.length)];
      if (!chosen) continue;

      await prisma.studentNewsSignal.upsert({
        where: { id: demoId(student.email, 'news-signal', signal.dayOffset) },
        create: {
          id: demoId(student.email, 'news-signal', signal.dayOffset),
          studentId: student.studentId,
          articleId: chosen.id,
          kind: signal.kind,
          dwellMs: signal.dwellMs || 0,
          createdAt: signal.at,
        },
        update: { kind: signal.kind, dwellMs: signal.dwellMs || 0, createdAt: signal.at },
      });

      // `now` is injected, so decay is computed exactly as it would have been
      // had the signal genuinely arrived on that day. applySignal and rebuildProfile
      // are designed to be idempotent — they're called on the same data every time
      // the server processes a real signal, so multiple runs should converge to the
      // same state.
      await applySignal(prisma, {
        studentId: student.studentId,
        article: chosen,
        kind: signal.kind,
        dwellMs: signal.dwellMs || 0,
        now: signal.at,
      });
      applied += 1;
    } catch (error) {
      console.warn(`[demo-history:ai] Failed to apply signal for ${student.email} at day ${signal.dayOffset}:`, error.message);
    }
  }

  try {
    await rebuildProfile(prisma, student.studentId);
  } catch (error) {
    console.warn(`[demo-history:ai] Failed to rebuild profile for ${student.email}:`, error.message);
  }
  return applied;
}

async function purge(students) {
  for (const student of students) {
    // Only delete the seeded rows, identified by their deterministic IDs.
    const seededSessionIds = student.studentPlan.sessions.map(s => s.id);
    await prisma.chatSession.deleteMany({ where: { id: { in: seededSessionIds } } });
    // Messages cascade from ChatSession.

    const seededSignalIds = student.studentPlan.newsSignals.map((_, i) =>
      demoId(student.email, 'news-signal', student.studentPlan.newsSignals[i].dayOffset)
    );
    await prisma.studentNewsSignal.deleteMany({ where: { id: { in: seededSignalIds } } });

    // Interest nodes/edges are created as a side effect of signals and profile rebuild,
    // so they're hard to pin down by id. Since they're derived, removing the student's
    // profile and rebuilding from the remaining signals is safer than trying to delete
    // specific nodes. For now, leave them — they'll expire naturally or the next run
    // will rebuild them identically.

    await prisma.studentLearningProfile.deleteMany({
      where: { id: demoId(student.email, 'learning-profile') },
    });
    await prisma.studentOnboarding.deleteMany({
      where: { id: demoId(student.email, 'onboarding') },
    });
    console.log(`[demo-history:ai] Purged ${student.email}`);
  }
}

async function main() {
  if (!assertSafeToRun()) return;

  const now = new Date();
  const fixture = loadPlan();

  // Purge works off the fixture's personas alone — it must be able to clean up
  // even when RAG is down or the corpus has since been emptied.
  if (PURGE) {
    const students = await resolveStudents(fixture.personas);
    await purge(students);
    console.log('[demo-history:ai] Purge complete.');
    return;
  }

  const corpus = await loadDemoCorpus(fixture, { label: 'demo-history:ai' });
  if (corpus.skip) return;

  const qaPairsByChapterKey = await loadChapterQa(fixture, corpus.chapters, { label: 'demo-history:ai' });
  const plan = buildDemoPlan({ plan: fixture, now, chapters: corpus.chapters, qaPairsByChapterKey });
  for (const warning of plan.warnings) console.warn(`[demo-history:ai] ${warning}`);

  const students = await resolveStudents(plan.students.map(s => s.persona));

  for (const studentPlan of plan.students) {
    const student = students.find(s => s.email === studentPlan.persona.email);
    if (!student) continue;

    await seedOnboarding(student, now);
    await seedChat(studentPlan, student);
    const signals = await seedNewsSignals(studentPlan, student, now);

    const chapters = [...new Set(studentPlan.sessions.map(
      session => `${session.subject} ch${session.chapterNumber} "${session.chapterName}"`,
    ))];
    console.log(
      `[demo-history:ai] ${student.email}: ` +
      `${studentPlan.sessions.length} sessions, ${studentPlan.turns.length * 2} messages, ` +
      `${signals} news signals — ${chapters.join(', ')}`
    );
  }

  console.log(`[demo-history:ai] Complete (corpus ${plan.chapterSetFingerprint}).`);
}

main()
  .catch(error => {
    console.error('[demo-history:ai] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
