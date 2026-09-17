'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConcept } = require('../concept-mapping');
const { enqueueEvidence, drainEvidence } = require('../evidence-outbox');
const { orderPractice } = require('../academic-support');
test('concept mapping never guesses a practice label', () => {
  assert.equal(resolveConcept('Fractions'), null);
  assert.equal(resolveConcept('Fractions', { chapter: { conceptCatalog: [{ conceptId: 'canonical-a', label: 'fractions' }] } }), 'canonical-a');
  assert.equal(resolveConcept('Fractions', { chapter: { conceptCatalog: [{ conceptId: 'a', label: 'fractions' }, { conceptId: 'b', label: 'fractions' }] } }), null);
});
test('teacher proposal identities are school and curriculum scoped', () => {
  const options = { chapter: { schoolId: 'school-a', subject: 'math', grade: 6 }, allowTeacherProposal: true };
  assert.notEqual(resolveConcept('fractions', options), resolveConcept('fractions', { ...options, chapter: { ...options.chapter, grade: 7 } }));
});
test('academic support reorders practice without changing questions or keys', () => {
  const a = { id: 'a', conceptId: 'a', correctAnswer: '2' }, b = { id: 'b', conceptId: 'b', correctAnswer: '4' };
  const original = [a, b];
  assert.deepEqual(orderPractice(original, [{ conceptId: 'b', gapScore: 0.8 }]), [b, a]);
  assert.deepEqual(original, [a, b]);
});
test('evidence remains pending on HTTP errors and incomplete acknowledgement', async () => {
  const rows = [{ id: 'event-1', payload: { eventId: 'event-1' }, attempts: 0 }];
  const updates = [];
  const prisma = { evidenceOutbox: {
    findMany: async () => rows,
    updateMany: async data => { updates.push(data); return { count: 1 }; },
    upsert: async data => { assert.equal(data.create.payload.eventId, 'event-1'); },
  } };
  await enqueueEvidence(prisma, [rows[0].payload]);
  const options = { url: 'http://psv', token: 'test', fetchImpl: async () => ({ ok: false, status: 503 }) };
  assert.equal(await drainEvidence(prisma, options), 0);
  assert.equal(updates[0].data.attempts.increment, 1);
  updates.length = 0;
  options.fetchImpl = async () => ({ ok: true, json: async () => ({ acceptedEventIds: [] }) });
  assert.equal(await drainEvidence(prisma, options), 0);
  assert.ok(!updates.some(row => row.data.deliveredAt));
  updates.length = 0;
  options.fetchImpl = async () => ({ ok: true, json: async () => ({ acceptedEventIds: ['event-1'] }) });
  assert.equal(await drainEvidence(prisma, options), 1);
  assert.ok(updates[0].data.deliveredAt);
});
test('service-local mapping and delivery contracts stay identical', () => {
  const fs = require('node:fs');
  for (const name of ['concept-mapping.js', 'evidence-outbox.js']) {
    assert.equal(fs.readFileSync(require.resolve('../' + name), 'utf8'), fs.readFileSync(require.resolve('../../quiz/' + name), 'utf8'));
  }
});

test('one malformed outcome cannot block delivery of valid outcomes', async () => {
  const updates = [];
  const rows = ['bad', 'good'].map(id => ({ id, payload: { eventId: id }, attempts: 0 }));
  const prisma = { evidenceOutbox: { findMany: async () => rows, updateMany: async data => updates.push(data) } };
  const sent = await drainEvidence(prisma, { url: 'http://test', token: 'test', fetchImpl: async (_url, request) => {
    const events = JSON.parse(request.body).events;
    if (events.some(row => row.eventId === 'bad')) return { ok: false, status: 422 };
    return { ok: true, status: 202, json: async () => ({ acceptedEventIds: events.map(row => row.eventId) }) };
  } });
  assert.equal(sent, 1);
  assert.ok(updates.find(row => row.where.id === 'bad').data.lastError.includes('422'));
  assert.ok(updates.find(row => row.where.id?.in?.includes('good')).data.deliveredAt);
});
