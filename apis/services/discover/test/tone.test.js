'use strict';
// hunt/tone.js — the Gen-Z tone rewrite pass for hunted (never RSS) articles.
//
// Like hunt/queries.js's own test suite, these deliberately do not exercise
// the live LLM call path (no mocking infra exists for structured-llm.js in
// this service, and hitting a real provider from a unit test is not
// something to rely on). rewriteBatch's post-generateStructured logic is
// factored into pure applyRewrites()/isRewriteSafe() functions specifically
// so the batch-assembly and safety-fallback behaviour is testable without a
// network call; the one whole-batch-failure test below stays fully offline
// by clearing both provider API keys, which makes resolveStructuredProvider
// throw synchronously before any fetch is attempted.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_TITLE_LENGTH, MAX_TITLE_LENGTH, MAX_SUMMARY_LENGTH,
  validateToneRewrites, buildTonePrompt,
  isRewriteSafe, applyRewrites, rewriteBatch, lookupExistingToneCache, applyToneRewrite,
} = require('../hunt/tone');

test('validateToneRewrites enforces exact count, unique index and bounds', () => {
  assert.throws(() => validateToneRewrites({ rewrites: 'nope' }, { count: 1 }), /must be an array/);
  assert.throws(() => validateToneRewrites({ rewrites: [] }, { count: 2 }), /exactly 2 entries/);
  assert.throws(
    () => validateToneRewrites({ rewrites: [{ index: 5, title: 'x'.repeat(20), summary: 'y'.repeat(30) }] }, { count: 1 }),
    /between 0 and 0/,
  );
  assert.throws(
    () => validateToneRewrites({
      rewrites: [
        { index: 0, title: 'x'.repeat(20), summary: 'y'.repeat(30) },
        { index: 0, title: 'x'.repeat(20), summary: 'y'.repeat(30) },
      ],
    }, { count: 2 }),
    /duplicates an earlier entry/,
  );
  assert.throws(
    () => validateToneRewrites({ rewrites: [{ index: 0, title: 'short', summary: 'y'.repeat(30) }] }, { count: 1 }),
    /title.*must be between/,
  );
  assert.throws(
    () => validateToneRewrites({ rewrites: [{ index: 0, title: 'x'.repeat(MIN_TITLE_LENGTH + 5), summary: 'too short' }] }, { count: 1 }),
    /summary.*must be between/,
  );
  assert.throws(
    () => validateToneRewrites({
      rewrites: [{ index: 0, title: 'x'.repeat(MAX_TITLE_LENGTH + 1), summary: 'y'.repeat(30) }],
    }, { count: 1 }),
    /title.*must be between/,
  );
});

test('validateToneRewrites accepts a well-formed batch and trims whitespace', () => {
  const out = validateToneRewrites({
    rewrites: [
      { index: 1, title: '  A livelier headline here  ', summary: 'y'.repeat(40) },
      { index: 0, title: 'x'.repeat(20), summary: 'z'.repeat(40) },
    ],
  }, { count: 2 });
  assert.equal(out.size, 2);
  assert.equal(out.get(1).title, 'A livelier headline here');
});

test('buildTonePrompt delimits article text as untrusted data', () => {
  const prompt = buildTonePrompt([{ title: 'Hello', summary: 'World' }]);
  assert.match(prompt, /<<<ARTICLES/);
  assert.match(prompt, /ARTICLES$/m);
  assert.match(prompt, /untrusted third-party content/i);
  assert.match(prompt, /\[0\]/);
});

test('isRewriteSafe accepts a clean rewrite and rejects one carrying a blocked term', () => {
  const article = { url: 'https://x.test/a', category: 'interests', title: 'Original', summary: 'Original summary text.' };
  const safeRewrite = {
    title: 'Students race tiny drones at the school fair',
    summary: 'A fun afternoon of drone racing built by young engineers.',
  };
  const unsafeRewrite = {
    title: 'Pilot killed in dramatic drone crash during air show',
    summary: 'A shocking accident left officials investigating live on air.',
  };
  assert.equal(isRewriteSafe(article, safeRewrite), true);
  assert.equal(isRewriteSafe(article, unsafeRewrite), false);
});

test('applyRewrites: one unsafe item falls back to its original text without sinking the batch', () => {
  const articles = [
    { url: 'https://x.test/a', category: 'interests', title: 'Original A', summary: 'Original summary A here.' },
    { url: 'https://x.test/b', category: 'interests', title: 'Original B', summary: 'Original summary B here.' },
  ];
  const byIndex = new Map([
    [0, { title: 'A much livelier headline for A', summary: 'A perfectly safe and livelier summary for article A.' }],
    [1, { title: 'Pilot killed in dramatic crash', summary: 'A shocking fatal accident during the display.' }],
  ]);
  const out = applyRewrites(articles, byIndex, { toneModel: 'test-model', toneProvider: 'test', logger: { warn: () => {} } });

  assert.equal(out[0].toneRewritten, true);
  assert.equal(out[0].title, 'A much livelier headline for A');
  assert.equal(out[0].toneModel, 'test-model');

  assert.equal(out[1].toneRewritten, undefined, 'the unsafe item keeps its original shape entirely');
  assert.equal(out[1].title, 'Original B', 'unsafe rewrite is discarded, original text kept');
});

test('applyRewrites: an article with no matching rewrite entry passes through untouched', () => {
  const articles = [{ url: 'https://x.test/a', title: 'Original', summary: 'Original summary.' }];
  const out = applyRewrites(articles, new Map(), {});
  assert.deepEqual(out, articles);
});

test('a whole-batch provider failure degrades every article to its original text', async () => {
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  const savedGroq = process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const articles = [
      { url: 'https://x.test/a', title: 'Original headline one', summary: 'Original summary text one, long enough.' },
      { url: 'https://x.test/b', title: 'Original headline two', summary: 'Original summary text two, long enough.' },
    ];
    const out = await rewriteBatch(articles, { logger: { warn: () => {} } });
    assert.deepEqual(out, articles, 'no provider configured -> generateStructured throws -> originals kept, never blocks');
  } finally {
    if (savedOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouter; else delete process.env.OPENROUTER_API_KEY;
    if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq; else delete process.env.GROQ_API_KEY;
  }
});

test('rewriteBatch is a no-op on an empty batch', async () => {
  assert.deepEqual(await rewriteBatch([], {}), []);
});

test('lookupExistingToneCache maps stored rows by url', async () => {
  const rows = [
    { url: 'https://x.test/a', title: 'T', summary: 'S', rawTitle: 'RT', rawSummary: 'RS', toneRewritten: true, toneModel: 'm', toneProvider: 'p' },
  ];
  const fakePrisma = { discoverArticle: { findMany: async () => rows } };
  const cache = await lookupExistingToneCache(fakePrisma, ['https://x.test/a']);
  assert.equal(cache.get('https://x.test/a').toneRewritten, true);
});

test('lookupExistingToneCache skips the query entirely for an empty url list', async () => {
  let called = false;
  const fakePrisma = { discoverArticle: { findMany: async () => { called = true; return []; } } };
  const cache = await lookupExistingToneCache(fakePrisma, []);
  assert.equal(called, false);
  assert.equal(cache.size, 0);
});

test('applyToneRewrite serves a cached rewrite without any LLM call when raw text is unchanged', async () => {
  const cachedRow = {
    url: 'https://x.test/a', title: 'Cached livelier title', summary: 'Cached livelier summary text here.',
    rawTitle: 'Original title', rawSummary: 'Original summary.', toneRewritten: true, toneModel: 'm', toneProvider: 'p',
  };
  const fakePrisma = { discoverArticle: { findMany: async () => [cachedRow] } };
  const candidates = [{ url: 'https://x.test/a', title: 'Original title', summary: 'Original summary.', category: 'interests' }];

  const out = await applyToneRewrite(fakePrisma, candidates, { logger: { warn: () => { throw new Error('should not warn/call the LLM path'); } } });

  assert.equal(out[0].toneRewritten, true);
  assert.equal(out[0].title, 'Cached livelier title');
  assert.equal(out[0].toneModel, 'm');
});

test('applyToneRewrite re-rewrites when the raw text has changed since the cached row', async () => {
  const staleRow = {
    url: 'https://x.test/a', title: 'Stale rewrite', summary: 'Stale summary.',
    rawTitle: 'A different original title', rawSummary: 'A different original summary.', toneRewritten: true, toneModel: 'm', toneProvider: 'p',
  };
  const fakePrisma = { discoverArticle: { findMany: async () => [staleRow] } };
  const candidates = [{ url: 'https://x.test/a', title: 'A brand new title', summary: 'A brand new summary text.', category: 'interests' }];

  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  const savedGroq = process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const out = await applyToneRewrite(fakePrisma, candidates, { logger: { warn: () => {} } });
    assert.equal(out[0].toneRewritten, false, 'raw text changed, so the stale cache is bypassed and a fresh attempt (which fails offline) runs instead');
    assert.equal(out[0].title, 'A brand new title', 'falls back to the freshly-fetched original, not the stale cached text');
  } finally {
    if (savedOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouter; else delete process.env.OPENROUTER_API_KEY;
    if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq; else delete process.env.GROQ_API_KEY;
  }
});

test('applyToneRewrite is a no-op on an empty candidate list', async () => {
  const fakePrisma = { discoverArticle: { findMany: async () => { throw new Error('should not query'); } } };
  assert.deepEqual(await applyToneRewrite(fakePrisma, [], {}), []);
});
