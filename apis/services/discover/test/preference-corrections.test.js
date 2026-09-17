'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createVocabulary } = require('../interest/vocab');
const { gatedTutorPreferences, gatedDiscoverPreferences, refreshPreferenceProfiles } = require('../preference/refresh');
const service = require('../preference/service');
const { PrismaClient } = require('@prisma/client');

test('tutor observations require distinct agreeing messages and respect explicit controls', () => {
  const rows = [1, 2].map(n => ({ topicKey: 'space', stance: 'LIKE', eventId: 'message-' + n, confidence: 0.9, createdAt: new Date(n), id: String(n) }));
  assert.equal(gatedTutorPreferences([rows[0], rows[0]], []).length, 0);
  assert.equal(gatedTutorPreferences(rows, []).length, 1);
  assert.equal(gatedTutorPreferences(rows, [{ topicKey: 'space', source: 'explicit' }]).length, 0);
  assert.equal(gatedTutorPreferences([rows[0], { ...rows[1], stance: 'DISLIKE' }], []).length, 0);
});

test('passive Discover inference requires distinct sessions and cannot replace existing preferences', () => {
  const vocab = createVocabulary();
  const rows = [1, 2].map(n => ({ id: String(n), kind: 'open', sessionId: 's' + n, article: { topics: ['space'] }, createdAt: new Date(n) }));
  assert.equal(gatedDiscoverPreferences(rows, [], vocab).length, 1);
  assert.equal(gatedDiscoverPreferences([rows[0], { ...rows[1], sessionId: 's1' }], [], vocab).length, 0);
  assert.equal(gatedDiscoverPreferences(rows, [{ topicKey: 'space', stance: 'DISLIKE' }], vocab).length, 0);
});

test('PostgreSQL: replay, mute, delete, erasure and pending tutor observations', { skip: !process.env.CORRECTIONS_TEST_DATABASE_URL }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.CORRECTIONS_TEST_DATABASE_URL } } });
  const studentId = randomUUID();
  const vocab = createVocabulary();
  try {
    await prisma.interestTopic.upsert({ where: { key: 'space' },
      create: { key: 'space', label: 'Space', cluster: 'science', terms: ['space'], status: 'active' },
      update: {} });
    const input = { studentId, topicKey: 'space', stance: 'LIKE', source: 'explicit', eventId: randomUUID() };
    const apply = () => service.withPreferenceLock(prisma, studentId, tx => service.applyPreference(tx, vocab, input));
    await apply();
    await service.mutePreference(prisma, vocab, { studentId, topicKey: 'space' });
    await apply();
    assert.equal((await prisma.studentPreference.findFirst({ where: { studentId } })).muted, true);
    await service.deletePreference(prisma, vocab, { studentId, topicKey: 'space' });
    await apply();
    assert.equal(await prisma.studentPreference.count({ where: { studentId } }), 0);
    await service.deletePreferenceProfile(prisma, studentId);
    await service.observeTutorText(prisma, vocab, { studentId, messageId: randomUUID(), text: 'I love space.' });
    assert.equal(await prisma.preferenceObservation.count({ where: { studentId } }), 0);
    assert.equal(await service.blocked(prisma, studentId, '*'), true);
    await service.setCollectionEnabled(prisma, vocab, studentId, true);
    assert.equal(await service.blocked(prisma, studentId, '*'), false);
    assert.equal(await prisma.studentPreference.count({ where: { studentId } }), 0);
    // No raw interests/stance are retained in a privacy-control receipt.
    const receipts = await prisma.preferenceReceipt.findMany({ where: { studentId } });
    assert.ok(receipts.length);
    assert.equal(receipts[0].topicKey, undefined);
  } finally {
    await service.deletePreferenceProfile(prisma, studentId);
    await prisma.$disconnect();
  }
});

test('PostgreSQL: daily observations activate once and in-flight erasure wins', { skip: !process.env.CORRECTIONS_TEST_DATABASE_URL }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.CORRECTIONS_TEST_DATABASE_URL } } });
  const studentId = randomUUID(), vocab = createVocabulary(), originalFetch = global.fetch;
  try {
    await prisma.interestTopic.upsert({ where: { key: 'space' }, create: { key: 'space', label: 'Space', cluster: 'science', terms: ['space'], status: 'active' }, update: {} });
    for (let i = 0; i < 2; i++) await service.observeTutorText(prisma, vocab, { studentId, messageId: randomUUID(), text: 'I love space.' });
    assert.equal(await prisma.studentPreference.count({ where: { studentId } }), 0);
    await refreshPreferenceProfiles(prisma, vocab, { runKey: 'test-' + randomUUID() });
    const active = await prisma.studentPreference.findFirst({ where: { studentId } });
    assert.equal(active.source, 'tutor_text');
    assert.equal(active.confidence, 0.65);
    const receiptCount = await prisma.preferenceReceipt.count({ where: { studentId } });
    await refreshPreferenceProfiles(prisma, vocab, { runKey: 'test-' + randomUUID() });
    assert.equal(await prisma.preferenceReceipt.count({ where: { studentId } }), receiptCount);
    global.fetch = async (_url, request) => {
      if (JSON.parse(request.body).studentId === studentId) await service.deletePreferenceProfile(prisma, studentId);
      return { ok: true, json: async () => ({ eligible: false, scores: [] }) };
    };
    await refreshPreferenceProfiles(prisma, vocab, { runKey: 'test-' + randomUUID(), gnnUrl: 'http://test-only', token: 'test' });
    assert.equal(await prisma.studentPreference.count({ where: { studentId } }), 0);
    assert.equal(await prisma.interestNode.count({ where: { studentId } }), 0);
    assert.equal(await service.blocked(prisma, studentId, '*'), true);
  } finally {
    global.fetch = originalFetch;
    await service.deletePreferenceProfile(prisma, studentId);
    await prisma.$disconnect();
  }
});
