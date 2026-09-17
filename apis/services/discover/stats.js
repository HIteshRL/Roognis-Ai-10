'use strict';
// Pure aggregation over a student's own NewsSignal rows for the student-facing
// "your reading stats" view. Deliberately has no Prisma/HTTP dependency of its
// own — the route handler in server.js does the fetch and passes plain rows
// in, which is what keeps this unit-testable without a database and keeps the
// arithmetic auditable in one place.
//
// No LLM anywhere in this file, and nothing here feeds a ranking or affinity
// score — SIGNAL_WEIGHTS in interest/graph.js is the only place that happens.
// This module only counts and sums what a student has already done.

const DEFAULT_DAYS = 30;

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function signalDate(signal) {
  const parsed = new Date(signal?.createdAt || 0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Consecutive UTC days, walking backward from `now`, with at least one
 * `open` or `dwell` signal. Mirrors the shape of buildLearningStreak in
 * services/analytics/lib/dashboard.js (same "today can be empty so far,
 * fall back to yesterday" rule) but is its own copy — services/discover
 * cannot import from services/analytics, there are no cross-service
 * imports anywhere in this repo.
 */
function readingStreakDays(signals, now) {
  const activeDays = new Set(
    signals
      .filter(s => s.kind === 'open' || s.kind === 'dwell')
      .map(s => dayKey(signalDate(s)))
  );

  if (!activeDays.size) return 0;

  let cursor = startOfUtcDay(now);
  if (!activeDays.has(dayKey(cursor))) {
    cursor = new Date(cursor.getTime() - 86400000);
  }

  let streak = 0;
  while (activeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return streak;
}

function topCategories(signals, limit = 3) {
  const counts = new Map();
  for (const s of signals) {
    if (s.kind !== 'open') continue;
    const category = s.article?.category;
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([category, count]) => ({ category, count }));
}

/**
 * @param {Array} signals - NewsSignal rows (each optionally carrying an
 *   `article: { category }` include), already filtered to one student.
 * @param {{now?: Date, days?: number}} [options] - `now` defaults to the
 *   current time but is a real parameter (not a Date.now() call inline)
 *   specifically so this stays a pure, deterministically-testable function.
 */
function buildReadingStats(signals, { now = new Date(), days = DEFAULT_DAYS } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const since = new Date(now.getTime() - days * 86400000);
  const inWindow = list.filter(s => signalDate(s) >= since && signalDate(s) <= now);

  const opens = inWindow.filter(s => s.kind === 'open');
  const dwells = inWindow.filter(s => s.kind === 'dwell');
  const headlineDwells = inWindow.filter(s => s.kind === 'headline_dwell');

  const articlesOpened = opens.length;
  const totalReadingSeconds = Math.round(
    dwells.reduce((sum, s) => sum + (Number(s.dwellMs) || 0), 0) / 1000
  );
  const totalHeadlineSeconds = Math.round(
    headlineDwells.reduce((sum, s) => sum + (Number(s.dwellMs) || 0), 0) / 1000
  );
  const avgSecondsPerArticle = articlesOpened > 0
    ? Math.round((totalReadingSeconds / articlesOpened) * 10) / 10
    : 0;

  return {
    articlesOpened,
    totalReadingSeconds,
    totalHeadlineSeconds,
    avgSecondsPerArticle,
    readingStreakDays: readingStreakDays(inWindow, now),
    topCategories: topCategories(inWindow),
  };
}

module.exports = { buildReadingStats };
