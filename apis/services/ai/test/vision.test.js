'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVisionRouter,
  normalizeReaderContext,
  questionAppearsVisual,
} = require('../vision');

function fakeRedis() {
  return {
    isOpen: true,
    on() {},
    async connect() {},
    async eval() { return 1; },
    async zRem() {},
    async get() { return null; },
    async incr() { return 1; },
    async expire() {},
    async set() {},
    async del() {},
  };
}

function response({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('reader context is bounded and visual intent is conservative', () => {
  assert.deepEqual(normalizeReaderContext({ page: 14, usePage: true }), { ok: true, value: { page: 14, usePage: true } });
  assert.equal(normalizeReaderContext({ page: 0 }).ok, false);
  assert.equal(normalizeReaderContext({ page: 14, usePage: 'yes' }).ok, false);
  assert.equal(questionAppearsVisual('Why are these two angles equal?'), false);
  assert.equal(questionAppearsVisual('Explain the graph on this page'), true);
});

test('NIM vision uses an image content part and shared admission', async () => {
  const calls = [];
  const router = createVisionRouter({
    createClient: fakeRedis,
    env: {
      VISION_ENABLED: 'true',
      VISION_MODE: 'always',
      REDIS_URL: 'redis://test',
      NIM_VISION_BASE_URL: 'http://nim/v1',
      NIM_VISION_MODEL: 'vlm-test',
    },
    fetchFn: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response({ body: { model: 'vlm-test', choices: [{ message: { content: 'The graph rises.' } }] } });
    },
    logger: { warn() {} },
  });
  const result = await router.generate({
    prompt: 'Read the page.',
    image: { mimeType: 'image/png', base64: 'aGVsbG8=' },
    schoolId: 'school-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(result.status, 'used');
  assert.equal(result.provider, 'nim');
  assert.equal(calls[0].url, 'http://nim/v1/chat/completions');
  assert.match(calls[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('temporary NIM failure fails over to Ollama native vision payload', async () => {
  let call = 0;
  const router = createVisionRouter({
    createClient: fakeRedis,
    env: {
      VISION_ENABLED: 'true',
      VISION_MODE: 'always',
      REDIS_URL: 'redis://test',
      VISION_PROVIDER_ORDER: 'nim,ollama',
      NIM_VISION_BASE_URL: 'http://nim/v1',
      NIM_VISION_MODEL: 'vlm-test',
      OLLAMA_VISION_URL: 'http://ollama',
      OLLAMA_VISION_MODEL: 'gemma3',
    },
    fetchFn: async (_url, options) => {
      call += 1;
      if (call === 1) return response({ status: 503, body: 'busy' });
      return response({ body: { model: 'gemma3', message: { content: 'The table compares two values.' } } });
    },
    logger: { warn() {} },
  });
  const result = await router.generate({
    prompt: 'Read the page.',
    image: { mimeType: 'image/png', base64: 'aGVsbG8=' },
    schoolId: 'school-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(result.status, 'used');
  assert.equal(result.provider, 'ollama');
  assert.deepEqual(result.attempts, ['nim_provider_unavailable', 'ollama_used']);
});

test('oversized page renders are rejected before a provider call', async () => {
  let calls = 0;
  const router = createVisionRouter({
    env: { VISION_ENABLED: 'true', VISION_MODE: 'always', NIM_VISION_BASE_URL: 'http://nim/v1', NIM_VISION_MODEL: 'vlm-test', VISION_MAX_IMAGE_BYTES: '4' },
    fetchFn: async () => { calls += 1; return response({ body: {} }); },
  });
  const result = await router.generate({
    prompt: 'Read the page.',
    image: { mimeType: 'image/png', base64: 'aGVsbG8=' },
    schoolId: 'school-1',
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.attempts, ['image_too_large']);
  assert.equal(calls, 0);
});
