'use strict';
// Cold start: the one-time import of a student's pre-Discover interest graph
// and their onboarding answers.
//
// The regression these guard against is real and was caught on a live stack:
// an earlier version stamped `importedLegacyGraphAt` even when services/ai had
// not answered, so a student who opened Discover during an ai outage lost their
// entire pre-existing graph permanently.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchLegacyProfile, ensureStudentBootstrapped, RETRY_BACKOFF_MS, _resetRetryBackoff,
} = require('../interest/bootstrap');
const { createVocabulary } = require('../interest/vocab');

const STUDENT = 'a8281567-ec2f-4d7e-902c-05cd1b7fd90e';

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** Minimal in-memory stand-in for the two Prisma models bootstrap touches. */
function fakePrisma({ profile = null } = {}) {
  const state = { profile, nodes: new Map(), topics: new Map() };
  return {
    state,
    studentInterestProfile: {
      findUnique: async () => state.profile,
      upsert: async ({ create, update }) => {
        state.profile = state.profile ? { ...state.profile, ...update } : { ...create };
        return state.profile;
      },
    },
    interestNode: {
      findUnique: async ({ where }) => {
        const { studentId, kind, key } = where.studentId_kind_key;
        return state.nodes.get(`${studentId}|${kind}|${key}`) || null;
      },
      upsert: async ({ where, create, update }) => {
        const { studentId, kind, key } = where.studentId_kind_key;
        const id = `${studentId}|${kind}|${key}`;
        const existing = state.nodes.get(id);
        const row = existing ? { ...existing, ...update } : { ...create };
        state.nodes.set(id, row);
        return row;
      },
    },
    interestTopic: {
      upsert: async ({ where, create }) => {
        if (!state.topics.has(where.key)) state.topics.set(where.key, { ...create });
        return state.topics.get(where.key);
      },
      findMany: async () => [...state.topics.values()],
    },
  };
}

test('a reachable services/ai returning nothing is still a real answer', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma();
  const fetchImpl = async () => jsonResponse({ nodes: [], interests: [] });

  const result = await ensureStudentBootstrapped(prisma, createVocabulary(), {
    studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl,
  });
  assert.equal(result.ran, true);
  assert.ok(prisma.state.profile.importedLegacyGraphAt, 'an empty-but-real answer stamps');
});

test('an unreachable services/ai does NOT stamp, so the import is not lost', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };

  const result = await ensureStudentBootstrapped(prisma, createVocabulary(), {
    studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl,
  });
  assert.equal(result.ran, false);
  assert.equal(result.deferred, true);
  assert.equal(prisma.state.profile, null, 'nothing is stamped, so a later request retries');
});

test('a deferred student is not retried on every request', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const opts = { studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl };

  await ensureStudentBootstrapped(prisma, createVocabulary(), opts);
  const afterFirst = calls;
  await ensureStudentBootstrapped(prisma, createVocabulary(), opts);
  assert.equal(calls, afterFirst, 'the backoff keeps a timing-out call out of the feed hot path');

  // Past the backoff window it tries again rather than giving up forever.
  await ensureStudentBootstrapped(prisma, createVocabulary(), {
    ...opts, now: new Date(Date.now() + RETRY_BACKOFF_MS + 1000),
  });
  assert.ok(calls > afterFirst, 'the deferral expires');
});

test('legacy nodes and onboarding interests both land, with their origin recorded', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma();
  const fetchImpl = async url => (url.includes('interest-graph')
    ? jsonResponse({ nodes: [
      { kind: 'genre', key: 'sports', weight: 2.4 },
      { kind: 'topic', key: 'cricket', weight: 1.1 },
      { kind: 'topic', key: 'space', weight: 0 },        // zero weight is dropped
      { kind: 'topic', weight: 3 },                       // keyless row is dropped
    ] })
    : jsonResponse({ interests: ['Space and technology', 'stories'] }));

  const vocab = createVocabulary();
  const result = await ensureStudentBootstrapped(prisma, vocab, {
    studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl,
  });

  assert.equal(result.imported, 2, 'only the two usable legacy nodes import');
  assert.equal(result.seeded, 2);

  const origins = [...prisma.state.nodes.values()].map(n => `${n.key}:${n.origin}`).sort();
  assert.deepEqual(origins, [
    'cricket:imported', 'space-and-technology:onboarding', 'sports:imported', 'story:onboarding',
  ]);
});

test('an onboarding answer with no matching seed topic creates one', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma();
  const fetchImpl = async url => (url.includes('interest-graph')
    ? jsonResponse({ nodes: [] })
    : jsonResponse({ interests: ['Drawing and making things'] }));

  const vocab = createVocabulary();
  await ensureStudentBootstrapped(prisma, vocab, {
    studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl,
  });
  assert.ok(vocab.has('drawing-and-making-thing'), 'the vocabulary grew to hold the answer');
  assert.ok(prisma.state.topics.has('drawing-and-making-thing'), 'and it was persisted');
});

test('the import is skipped entirely once it has succeeded', async () => {
  _resetRetryBackoff();
  const prisma = fakePrisma({ profile: { importedLegacyGraphAt: new Date() } });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ nodes: [], interests: [] }); };

  const result = await ensureStudentBootstrapped(prisma, createVocabulary(), {
    studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: 't', fetchImpl,
  });
  assert.equal(result.ran, false);
  assert.equal(calls, 0, 'no outbound call on the steady-state path');
});

test('with no internal token configured nothing is fetched', async () => {
  _resetRetryBackoff();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };
  const out = await fetchLegacyProfile({ studentId: STUDENT, aiServiceUrl: 'http://ai:3002', token: '', fetchImpl });
  assert.equal(calls, 0);
  assert.deepEqual(out.nodes, []);
  assert.deepEqual(out.interests, []);
});
