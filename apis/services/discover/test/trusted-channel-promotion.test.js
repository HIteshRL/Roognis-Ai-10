'use strict';
// Channel trust reuses interest/promote.js's candidateDecision()/mergeEvidence()
// directly — this file proves that reuse actually holds (the same
// distinct-sessions gate interests already use), not a parallel
// reimplementation that could silently drift from it. If interest/promote.js's
// own tests ever change behaviour, this file should visibly break too.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROMOTION_EVIDENCE_THRESHOLD } = require('../interest/promote');
const {
  parseSeedChannels, seedTrustedChannels, computeTopicNarrowness, recordChannelEvidence,
} = require('../video/trust');
const { createVocabulary } = require('../interest/vocab');

/** Minimal in-memory stand-in for the one Prisma model this file touches. */
function fakePrisma() {
  const state = { channels: new Map() };
  return {
    state,
    trustedChannel: {
      findUnique: async ({ where: { channelId } }) => state.channels.get(channelId) || null,
      upsert: async ({ where: { channelId }, create, update }) => {
        const existing = state.channels.get(channelId);
        const row = existing ? { ...existing, ...update } : { channelId, ...create };
        state.channels.set(channelId, row);
        return row;
      },
    },
  };
}

test('three distinct sessions are what it takes to auto-promote a channel, same threshold as interests', async () => {
  const prisma = fakePrisma();
  for (let i = 0; i < PROMOTION_EVIDENCE_THRESHOLD; i += 1) {
    await recordChannelEvidence(prisma, {
      channelId: 'UCabc', channelName: 'Some Analyst', sessionId: `s${i}`, videoUrl: `https://youtube.com/watch?v=v${i}`,
    });
  }
  const channel = prisma.state.channels.get('UCabc');
  assert.equal(channel.status, 'trusted');
  assert.equal(channel.evidenceCount, PROMOTION_EVIDENCE_THRESHOLD);
  assert.ok(channel.promotedAt);
});

test('two distinct sessions are not enough — the same asymmetry as interest candidates', async () => {
  const prisma = fakePrisma();
  await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: 's1', videoUrl: 'https://youtube.com/watch?v=v1' });
  const result = await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: 's2', videoUrl: 'https://youtube.com/watch?v=v2' });
  assert.equal(result.action, 'noop');
  assert.equal(prisma.state.channels.get('UCabc').status, 'pending');
});

test('the same session watching multiple videos from a channel counts once, not once per video', async () => {
  const prisma = fakePrisma();
  await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: 's1', videoUrl: 'https://youtube.com/watch?v=v1' });
  await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: 's1', videoUrl: 'https://youtube.com/watch?v=v2' });
  assert.equal(prisma.state.channels.get('UCabc').evidenceCount, 1, 'one session, one observation');
});

test('an already-trusted channel stays trusted and is a no-op action, mirroring an already-accepted interest candidate', async () => {
  const prisma = fakePrisma();
  for (let i = 0; i < PROMOTION_EVIDENCE_THRESHOLD; i += 1) {
    await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: `s${i}` });
  }
  const result = await recordChannelEvidence(prisma, { channelId: 'UCabc', channelName: 'X', sessionId: 's99' });
  assert.equal(result.action, 'noop');
  assert.equal(result.channel.status, 'trusted');
});

test('a channel with no id is a safe no-op, never crashes', async () => {
  const prisma = fakePrisma();
  const result = await recordChannelEvidence(prisma, { channelId: null, sessionId: 's1' });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'no_channel');
});

// ── cold-start seeding ───────────────────────────────────────────────────────
test('parseSeedChannels parses "id:Label" pairs by channel id, not display name', () => {
  const parsed = parseSeedChannels('UCabc:Some Analyst,UCdef:Another One');
  assert.deepEqual(parsed, [
    { channelId: 'UCabc', channelName: 'Some Analyst' },
    { channelId: 'UCdef', channelName: 'Another One' },
  ]);
});

test('parseSeedChannels degrades cleanly for blank or malformed input', () => {
  assert.deepEqual(parseSeedChannels(''), []);
  assert.deepEqual(parseSeedChannels(undefined), []);
  assert.deepEqual(parseSeedChannels('  ,  ,UCabc:X  '), [{ channelId: 'UCabc', channelName: 'X' }]);
});

test('seedTrustedChannels bypasses the evidence gate entirely', async () => {
  const prisma = fakePrisma();
  const seeded = await seedTrustedChannels(prisma, { DISCOVER_VIDEO_TRUSTED_CHANNELS: 'UCabc:Some Analyst' }, { logger: { log: () => {} } });
  assert.equal(seeded, 1);
  const channel = prisma.state.channels.get('UCabc');
  assert.equal(channel.status, 'trusted');
  assert.equal(channel.seedSource, 'curated');
  assert.equal(channel.evidenceCount, undefined, 'no evidence accrual for a seeded channel');
});

test('seeding never demotes a channel that evidence or a manual decision already decided', async () => {
  const prisma = fakePrisma();
  prisma.state.channels.set('UCabc', { channelId: 'UCabc', status: 'blocked', channelName: 'X' });
  await seedTrustedChannels(prisma, { DISCOVER_VIDEO_TRUSTED_CHANNELS: 'UCabc:Some Analyst' }, { logger: { log: () => {} } });
  assert.equal(prisma.state.channels.get('UCabc').status, 'blocked', 'a later seed list must not override an operator decision');
});

// ── the niche signal itself ──────────────────────────────────────────────────
test('computeTopicNarrowness scores a single-topic channel as fully narrow', () => {
  const vocab = createVocabulary();
  const titles = [
    'NASA launches new satellite mission',
    'How rockets reach orbit',
    'ISRO announces next moon mission',
    'What a telescope actually sees in deep space',
  ];
  const { topicNarrowness, dominantTopicKey } = computeTopicNarrowness(titles, vocab);
  assert.equal(dominantTopicKey, 'space');
  assert.equal(topicNarrowness, 1, 'every sampled upload matches the same topic');
});

test('computeTopicNarrowness scores a multi-topic newsroom-style channel as low', () => {
  const vocab = createVocabulary();
  const titles = [
    'NASA launches new satellite mission',
    'Latest football scores tonight',
    'Stock market update today',
    'New smartphone review',
  ];
  const { topicNarrowness } = computeTopicNarrowness(titles, vocab);
  assert.ok(topicNarrowness <= 0.5, `a spread-across-desks channel must score low, got ${topicNarrowness}`);
});

test('computeTopicNarrowness returns null for an empty or entirely unmatched upload sample', () => {
  const vocab = createVocabulary();
  assert.deepEqual(computeTopicNarrowness([], vocab), { topicNarrowness: null, dominantTopicKey: null });
  assert.deepEqual(computeTopicNarrowness(['asdkjfh qwoiuer'], vocab), { topicNarrowness: null, dominantTopicKey: null });
});
