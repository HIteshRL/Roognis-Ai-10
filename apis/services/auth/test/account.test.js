const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProvisionRequest, validatePassword } = require('../lib/account');

test('normalizes a teacher-provisioned student account', () => {
  assert.deepEqual(normalizeProvisionRequest({
    name: '  Student One ',
    email: 'STUDENT@EXAMPLE.COM',
    role: 'student',
    password: 'long-student-password',
  }), {
    name: 'Student One',
    email: 'student@example.com',
    role: 'student',
    password: 'long-student-password',
  });
});

test('prevents teachers from provisioning another teacher', () => {
  assert.throws(() => normalizeProvisionRequest({
    name: 'Other Teacher',
    email: 'other@example.com',
    role: 'teacher',
    password: 'long-random-password',
  }), /only student or parent/);
});

test('rejects weak and public demo passwords', () => {
  assert.throws(() => validatePassword('short'), /at least 10/);
  assert.throws(() => validatePassword('demo1234'), /public demo password/);
});
