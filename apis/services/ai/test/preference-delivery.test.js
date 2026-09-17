'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverPreferenceObservations } = require('../preference-delivery');
test('tutor delivery retries failures and never transmits assistant/removed messages', async () => {
  const updates = [], requests = [];
  const jobs = ['user', 'assistant', 'removed'].map(role => ({ messageId: role, studentId: 'student', attempts: 0 }));
  const prisma = {
    preferenceDelivery: { findMany: async () => jobs, update: async value => updates.push(value) },
    message: { findUnique: async ({ where }) => where.id === 'removed' ? null : { role: where.id, content: 'I like space' } },
  };
  await deliverPreferenceObservations(prisma, { url: 'http://discover', token: 'test', fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body)); return { ok: false, status: 503 };
  } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { studentId: 'student', messageId: 'user', text: 'I like space' });
  assert.equal(updates[0].data.attempts.increment, 1);
  assert.equal(updates[0].data.deliveredAt, undefined);
  assert.ok(updates[1].data.deliveredAt && updates[2].data.deliveredAt);
  assert.ok(!JSON.stringify(updates).includes('I like space'));
});
