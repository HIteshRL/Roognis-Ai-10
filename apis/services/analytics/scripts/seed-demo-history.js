'use strict';

/**
 * Seeds the demo event stream and the teacher's class roster.
 *
 * Runs LAST of the three seeders, because every event it writes describes a row
 * one of the others already wrote. It never reads their schemas: session ids
 * are re-derived from the same inputs, and quiz weak areas are pulled from the
 * quiz service's existing internal endpoint over HTTP.
 *
 * Events are written through Prisma rather than the HTTP route for one reason:
 * `POST /api/analytics/event` has no timestamp field and `Event.createdAt`
 * defaults to now(), so backdating is impossible over the wire. Validation is
 * NOT bypassed — every type goes through the same `validateEventType` the route
 * uses, so this cannot mint a type the allowlist would reject.
 *
 * Run:   node scripts/seed-demo-history.js
 * Purge: node scripts/seed-demo-history.js --purge
 */

const { PrismaClient } = require('@prisma/client');

const { demoId } = require('/app/seed-data/demo-history/lib/demo-ids');
const { buildDemoPlan, loadPlan } = require('/app/seed-data/demo-history/lib/demo-plan');
const { loadDemoCorpus } = require('/app/seed-data/demo-history/lib/demo-corpus');
const { validateEventType } = require('../lib/validation');

const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3001';
const QUIZ_SERVICE_URL = process.env.QUIZ_SERVICE_URL || 'http://quiz:3005';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const TEACHER_EMAIL = process.env.DEMO_TEACHER_EMAIL || 'teacher@demo.com';
// Tags a row as written by the demo seeder, and `--purge` matches on it. It is
// NOT a fixture revision: bumping it with plan.json's `version` would orphan
// every previously seeded event from its own teardown. The fixture revision
// rides alongside as `metadata.planVersion`.
const SEED_MARKER = 'demo-history-v1';
const PURGE = process.argv.includes('--purge');

function assertSafeToRun() {
  if (process.env.SEED_DEMO_HISTORY !== 'true') {
    console.log('[demo-history:analytics] SEED_DEMO_HISTORY is not "true" — nothing to do.');
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
  return response.json();
}

/**
 * Real weak areas for a student, from the quiz service.
 *
 * This endpoint already exists and already returns exactly this shape — using
 * it means the labels on a `quiz_submitted` event are the same labels the quiz
 * service will report when a teacher drills into that student.
 */
async function fetchWeakAreas(studentId, schoolId) {
  if (!INTERNAL_SERVICE_TOKEN) return [];
  const url = new URL(`${QUIZ_SERVICE_URL}/api/quiz/internal/student-learning-context`);
  url.searchParams.set('studentId', studentId);
  url.searchParams.set('schoolId', schoolId);
  try {
    const response = await fetch(url, {
      headers: { 'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN },
    });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body.weakAreas) ? body.weakAreas : [];
  } catch (error) {
    console.warn('[demo-history:analytics] Could not read quiz context:', error.message);
    return [];
  }
}

/** Every event goes through the allowlist the HTTP route enforces. */
function event({ kind, index, student, type, at, subject, sessionId, metadata }) {
  const validated = validateEventType(type);
  if (!validated) {
    throw new Error(`Refusing to write "${type}": not in KNOWN_EVENT_TYPES.`);
  }
  return {
    id: demoId(student.email, kind, index),
    type: validated,
    studentId: student.studentId,
    schoolId: process.env.DEMO_SCHOOL_ID,
    subject: subject || null,
    sessionId: sessionId || null,
    // Marks the row as synthetic. Survives metadata sanitisation deliberately —
    // labelled demo data is a feature, not a leak.
    metadata: { ...(metadata || {}), seed: SEED_MARKER },
    createdAt: at,
  };
}

function buildEvents(studentPlan, student, weakAreas) {
  const rows = [];

  // Onboarding timestamp must match the AI seeder's completedAt, which is dayAt(29, now).
  // This ensures the event timestamp aligns with the onboarding record.
  const onboardingAt = studentPlan.sessions[0].at;
  onboardingAt.setUTCDate(onboardingAt.getUTCDate() - 29);
  onboardingAt.setUTCHours(12, 0, 0, 0);

  rows.push(event({
    kind: 'ev-onboarding', index: 0, student,
    type: 'student_onboarding_completed',
    at: onboardingAt,
    metadata: {},
  }));

  for (const session of studentPlan.sessions) {
    rows.push(event({
      kind: 'ev-lesson', index: session.dayOffset, student,
      type: 'lesson_started', at: session.at, subject: session.subject,
      sessionId: session.id,
      metadata: { chapterNumber: session.chapterNumber, chapterName: session.chapterName },
    }));
  }

  for (const turn of studentPlan.turns) {
    rows.push(event({
      kind: 'ev-chat', index: `${turn.dayOffset}-${turn.index}`, student,
      type: 'chat_message', at: turn.at, subject: turn.subject,
      // The session id is re-derived, not passed — this is what makes the
      // dashboard's session count agree with the AI service's actual rows.
      sessionId: turn.sessionId,
      metadata: {},
    }));
  }

  for (const tick of studentPlan.studyTicks) {
    rows.push(event({
      kind: 'ev-study', index: tick.dayOffset, student,
      type: 'study_time_tracked', at: tick.at, subject: tick.subject,
      metadata: { activeSeconds: tick.activeSeconds },
    }));
  }

  for (const entry of studentPlan.feedback) {
    rows.push(event({
      kind: 'ev-feedback', index: entry.dayOffset, student,
      type: 'feedback_submitted', at: entry.at, subject: entry.subject,
      sessionId: entry.sessionId,
      metadata: { rating: entry.rating },
    }));
  }

  for (const diagram of studentPlan.diagrams) {
    rows.push(event({
      kind: 'ev-diagram', index: diagram.dayOffset, student,
      type: 'image_generated', at: diagram.at, subject: diagram.subject,
      metadata: { topic: diagram.prompt },
    }));
  }

  for (const video of studentPlan.videos) {
    rows.push(event({
      kind: 'ev-video-rec', index: video.dayOffset, student,
      type: 'video_recommended', at: video.at, subject: video.subject,
      metadata: { topic: video.topic },
    }));
    if (video.opened) {
      rows.push(event({
        kind: 'ev-video-open', index: video.dayOffset, student,
        type: 'video_opened', at: new Date(video.at.getTime() + 60 * 1000),
        subject: video.subject, metadata: { topic: video.topic },
      }));
    }
  }

  for (const [i, attempt] of studentPlan.attempts.entries()) {
    // Weak areas rotate through the student's real ones, so the teacher's
    // weak-area card reflects labels the quiz service will corroborate.
    const slice = weakAreas.slice(i % Math.max(1, weakAreas.length)).slice(0, 3);
    const labels = slice.map(area => area.label).filter(Boolean);

    rows.push(event({
      kind: 'ev-quiz-open', index: attempt.dayOffset, student,
      type: 'quiz_opened', at: attempt.at, subject: attempt.subject,
      metadata: { chapterNumber: attempt.chapterNumber },
    }));
    rows.push(event({
      kind: 'ev-quiz-submit', index: attempt.dayOffset, student,
      type: 'quiz_submitted', at: new Date(attempt.at.getTime() + 12 * 60 * 1000),
      subject: attempt.subject,
      metadata: {
        chapterNumber: attempt.chapterNumber,
        scorePercent: attempt.scorePercent,
        weakAreas: labels,
      },
    }));
    rows.push(event({
      kind: 'ev-quiz-graded', index: attempt.dayOffset, student,
      type: 'quiz_graded', at: new Date(attempt.at.getTime() + 13 * 60 * 1000),
      subject: attempt.subject,
      metadata: {
        chapterNumber: attempt.chapterNumber,
        scorePercent: attempt.scorePercent,
        weakAreas: labels,
      },
    }));
  }

  return rows;
}

/**
 * Assign the demo students to the demo teacher.
 *
 * Without this the dashboard falls back to a school-wide roster, which papers
 * over a real inconsistency: the teacher sees students that the per-student
 * endpoint then 404s on, because that route checks assignment. Seeding the
 * assignments makes both agree.
 */
async function seedRoster(teacherId, students) {
  for (const student of students) {
    await prisma.classAssignment.upsert({
      where: {
        teacherId_studentId_subject: {
          teacherId, studentId: student.studentId, subject: 'general',
        },
      },
      create: {
        id: demoId(student.email, 'class-assignment'),
        schoolId: process.env.DEMO_SCHOOL_ID,
        teacherId,
        studentId: student.studentId,
        className: 'Class 8A',
        subject: 'general',
      },
      update: { className: 'Class 8A' },
    });
  }
}

async function main() {
  if (!assertSafeToRun()) return;

  const schoolId = process.env.DEMO_SCHOOL_ID;
  const fixture = loadPlan();
  const teacher = await login(TEACHER_EMAIL);

  const resolveStudent = async persona => {
    const body = await login(persona.email);
    if (body.role !== 'student') {
      throw new Error(`Refusing to seed: ${persona.email} is a ${body.role}.`);
    }
    return { email: persona.email, studentId: body.userId };
  };

  // Purge works off the fixture's personas alone, so it can still clean up when
  // RAG is down or the corpus has since been emptied.
  if (PURGE) {
    for (const persona of fixture.personas) {
      const student = await resolveStudent(persona);
      const { count } = await prisma.event.deleteMany({
        where: { studentId: student.studentId, metadata: { path: ['seed'], equals: SEED_MARKER } },
      });
      // Only delete the seeded assignment, identified by its deterministic ID.
      await prisma.classAssignment.deleteMany({
        where: { id: demoId(student.email, 'class-assignment') },
      });
      console.log(`[demo-history:analytics] Purged ${count} events for ${student.email}`);
    }
    return;
  }

  const corpus = await loadDemoCorpus(fixture, { label: 'demo-history:analytics' });
  if (corpus.skip) return;

  const plan = buildDemoPlan({ plan: fixture, now: new Date(), chapters: corpus.chapters });
  for (const warning of plan.warnings) console.warn(`[demo-history:analytics] ${warning}`);

  const students = [];
  for (const studentPlan of plan.students) {
    students.push({ ...(await resolveStudent(studentPlan.persona)), studentPlan });
  }

  await seedRoster(teacher.userId, students);

  let total = 0;
  for (const student of students) {
    const weakAreas = await fetchWeakAreas(student.studentId, schoolId);
    // Which fixture revision, and which corpus, produced this row. The three
    // seeders each call RAG separately; if the corpus shifted between two of
    // those calls the fingerprints disagree, and that is visible in the data
    // rather than only in a log line nobody kept.
    const rows = buildEvents(student.studentPlan, student, weakAreas).map(row => ({
      ...row,
      metadata: { ...row.metadata, planVersion: plan.version, corpus: plan.chapterSetFingerprint },
    }));

    for (const row of rows) {
      await prisma.event.upsert({
        where: { id: row.id },
        create: row,
        update: { metadata: row.metadata, createdAt: row.createdAt },
      });
    }

    total += rows.length;
    console.log(
      `[demo-history:analytics] ${student.email}: ${rows.length} events` +
      (weakAreas.length ? ` (${weakAreas.length} real weak areas)` : ' (no quiz data yet)')
    );
  }

  console.log(
    `[demo-history:analytics] Complete — ${total} events across ${students.length} students ` +
    `(corpus ${plan.chapterSetFingerprint}).`
  );
}

main()
  .catch(error => {
    console.error('[demo-history:analytics] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
