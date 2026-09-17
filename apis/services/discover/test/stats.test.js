'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReadingStats } = require('../stats');

const NOW = new Date('2026-08-21T12:00:00.000Z');

function iso(daysAgo, hour = 12) {
  const d = new Date(NOW.getTime() - daysAgo * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function signal(overrides) {
  return {
    id: 'sig-' + Math.random().toString(36).slice(2),
    studentId: 'student-1',
    articleId: 'article-1',
    sessionId: null,
    kind: 'open',
    dwellMs: 0,
    createdAt: iso(0),
    article: { category: 'technology' },
    ...overrides,
  };
}

test('empty signals array yields a clean zeroed shape, no throw', () => {
  const stats = buildReadingStats([], { now: NOW });
  assert.deepEqual(stats, {
    articlesOpened: 0,
    totalReadingSeconds: 0,
    totalHeadlineSeconds: 0,
    avgSecondsPerArticle: 0,
    readingStreakDays: 0,
    topCategories: [],
  });
});

test('is a pure function of its inputs — same signals + same now always yields the same result', () => {
  const signals = [
    signal({ kind: 'open', createdAt: iso(0) }),
    signal({ kind: 'dwell', dwellMs: 15000, createdAt: iso(0) }),
  ];
  const a = buildReadingStats(signals, { now: NOW });
  const b = buildReadingStats(signals, { now: NOW });
  assert.deepEqual(a, b);
});

test('counts articlesOpened from open signals only', () => {
  const signals = [
    signal({ kind: 'open' }),
    signal({ kind: 'open' }),
    signal({ kind: 'impression' }),
    signal({ kind: 'dwell', dwellMs: 5000 }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.articlesOpened, 2);
});

test('sums dwell and headline_dwell independently into their own totals', () => {
  const signals = [
    signal({ kind: 'dwell', dwellMs: 30000 }),
    signal({ kind: 'dwell', dwellMs: 90000 }),
    signal({ kind: 'headline_dwell', dwellMs: 500 }),
    signal({ kind: 'headline_dwell', dwellMs: 1500 }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.totalReadingSeconds, 120); // (30000+90000)/1000
  assert.equal(stats.totalHeadlineSeconds, 2);  // (500+1500)/1000
});

test('avgSecondsPerArticle divides reading seconds by articles opened, rounded to 1 decimal', () => {
  const signals = [
    signal({ kind: 'open' }),
    signal({ kind: 'open' }),
    signal({ kind: 'open' }),
    signal({ kind: 'dwell', dwellMs: 100000 }), // 100s total / 3 opens = 33.333...
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.totalReadingSeconds, 100);
  assert.equal(stats.avgSecondsPerArticle, 33.3);
});

test('avgSecondsPerArticle is 0, not NaN or Infinity, when no articles were opened', () => {
  const signals = [signal({ kind: 'dwell', dwellMs: 50000 })];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.articlesOpened, 0);
  assert.equal(stats.avgSecondsPerArticle, 0);
  assert.ok(Number.isFinite(stats.avgSecondsPerArticle));
});

test('readingStreakDays counts consecutive days back from now with open/dwell activity', () => {
  const signals = [
    signal({ kind: 'open', createdAt: iso(0) }),
    signal({ kind: 'dwell', dwellMs: 1000, createdAt: iso(1) }),
    signal({ kind: 'open', createdAt: iso(2) }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.readingStreakDays, 3);
});

test('readingStreakDays stops at a gap', () => {
  const signals = [
    signal({ kind: 'open', createdAt: iso(0) }),
    signal({ kind: 'open', createdAt: iso(1) }),
    // gap at day 2
    signal({ kind: 'open', createdAt: iso(3) }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.readingStreakDays, 2);
});

test('readingStreakDays tolerates today having no activity yet, continuing from yesterday', () => {
  const signals = [
    signal({ kind: 'open', createdAt: iso(1) }),
    signal({ kind: 'open', createdAt: iso(2) }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.readingStreakDays, 2);
});

test('readingStreakDays ignores impression/skip/headline_dwell-only days', () => {
  const signals = [
    signal({ kind: 'impression', createdAt: iso(0) }),
    signal({ kind: 'skip', createdAt: iso(0) }),
    signal({ kind: 'headline_dwell', dwellMs: 500, createdAt: iso(0) }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.readingStreakDays, 0);
});

test('readingStreakDays is 0 for an entirely empty history', () => {
  const stats = buildReadingStats([], { now: NOW });
  assert.equal(stats.readingStreakDays, 0);
});

test('topCategories ranks by open count descending', () => {
  const signals = [
    signal({ kind: 'open', article: { category: 'science' } }),
    signal({ kind: 'open', article: { category: 'science' } }),
    signal({ kind: 'open', article: { category: 'sports' } }),
    signal({ kind: 'open', article: { category: 'technology' } }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.deepEqual(stats.topCategories, [
    { category: 'science', count: 2 },
    { category: 'sports', count: 1 },
    { category: 'technology', count: 1 },
  ]);
});

test('topCategories breaks ties by category name ascending', () => {
  const signals = [
    signal({ kind: 'open', article: { category: 'world' } }),
    signal({ kind: 'open', article: { category: 'business' } }),
    signal({ kind: 'open', article: { category: 'india' } }),
  ];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.deepEqual(stats.topCategories, [
    { category: 'business', count: 1 },
    { category: 'india', count: 1 },
    { category: 'world', count: 1 },
  ]);
});

test('topCategories is limited to the top 3', () => {
  const cats = ['top', 'india', 'business', 'technology', 'science'];
  const signals = cats.map(category => signal({ kind: 'open', article: { category } }));
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.topCategories.length, 3);
});

test('a signal outside the days window does not count toward any total', () => {
  const signals = [
    signal({ kind: 'open', createdAt: iso(5) }),           // inside a 7-day window
    signal({ kind: 'open', createdAt: iso(40) }),           // outside a 7-day window
    signal({ kind: 'dwell', dwellMs: 20000, createdAt: iso(40) }), // outside too
  ];
  const stats = buildReadingStats(signals, { now: NOW, days: 7 });
  assert.equal(stats.articlesOpened, 1);
  assert.equal(stats.totalReadingSeconds, 0);
});

test('days window is inclusive of the boundary and widening it picks up older signals', () => {
  const signals = [signal({ kind: 'open', createdAt: iso(10) })];
  const narrow = buildReadingStats(signals, { now: NOW, days: 5 });
  const wide = buildReadingStats(signals, { now: NOW, days: 30 });
  assert.equal(narrow.articlesOpened, 0);
  assert.equal(wide.articlesOpened, 1);
});

test('defaults to a 30-day window when days is not provided', () => {
  const signals = [signal({ kind: 'open', createdAt: iso(29) })];
  const stats = buildReadingStats(signals, { now: NOW });
  assert.equal(stats.articlesOpened, 1);
});
