const test = require('node:test');
const assert = require('node:assert/strict');
const { requestHash, isUuid, slug } = require('../src/security');
const { workflowData } = require('../src/workflows');

test('request hashes are stable across object key order', () => {
  assert.equal(requestHash({ b: 2, a: [1, { z: true }] }), requestHash({ a: [1, { z: true }], b: 2 }));
});
test('school slug and UUID validation reject unsafe selectors', () => {
  assert.equal(slug('  Dayananda Sagar / North  '), 'dayananda-sagar-north');
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isUuid('not-an-id'), false);
});
test('workflow runs pin an allow-listed template version', () => {
  const data = workflowData({ schoolId: '550e8400-e29b-41d4-a716-446655440000', templateKey: 'new_admission', idempotencyKey: 'admission-1', input: {}, actorId: null, correlationId: '550e8400-e29b-41d4-a716-446655440000' });
  assert.equal(data.run.status, 'WAITING_EXTERNAL');
  assert.equal(data.steps.create[1].status, 'WAITING_EXTERNAL');
  assert.throws(() => workflowData({ schoolId: 'x', templateKey: 'arbitrary-code', idempotencyKey: 'x', input: {} }), /Unsupported/);
});
