const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveBootstrapConfig } = require('../lib/bootstrap');

test('keeps all automatic user creation disabled by default', () => {
  assert.deepEqual(resolveBootstrapConfig({}), { mode: 'disabled' });
});

test('accepts a complete one-time production bootstrap', () => {
  const config = resolveBootstrapConfig({
    BOOTSTRAP_ENABLED: 'true',
    BOOTSTRAP_SCHOOL_ID: '550e8400-e29b-41d4-a716-446655440000',
    BOOTSTRAP_SCHOOL_NAME: 'Roognis Pilot School',
    BOOTSTRAP_TEACHER_NAME: 'Pilot Teacher',
    BOOTSTRAP_TEACHER_EMAIL: 'Teacher@Example.com',
    BOOTSTRAP_TEACHER_PASSWORD: 'a-long-random-password',
  });
  assert.equal(config.mode, 'production');
  assert.equal(config.teacherEmail, 'teacher@example.com');
});

test('rejects missing values and the public demo password', () => {
  assert.throws(
    () => resolveBootstrapConfig({ BOOTSTRAP_ENABLED: 'true' }),
    /Missing production bootstrap values/
  );
  assert.throws(
    () => resolveBootstrapConfig({
      BOOTSTRAP_ENABLED: 'true',
      BOOTSTRAP_SCHOOL_ID: '550e8400-e29b-41d4-a716-446655440000',
      BOOTSTRAP_SCHOOL_NAME: 'School',
      BOOTSTRAP_TEACHER_NAME: 'Teacher',
      BOOTSTRAP_TEACHER_EMAIL: 'teacher@example.com',
      BOOTSTRAP_TEACHER_PASSWORD: 'demo1234',
    }),
    /cannot be the demo password/
  );
});
