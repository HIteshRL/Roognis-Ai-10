const test = require('node:test');
const assert = require('node:assert/strict');

const { AuthDirectoryUnavailable, createAuthStudentDirectory } = require('../lib/auth-student-directory');

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('uses the narrow Auth student projection with the internal token', async () => {
  const requests = [];
  const directory = createAuthStudentDirectory({
    baseUrl: 'http://auth:3001/',
    internalServiceToken: 'shared-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { studentId: 'student-a', schoolId: 'school-a' });
    },
  });

  assert.deepEqual(await directory.findStudentInSchool('student-a', 'school-a'), {
    studentId: 'student-a', schoolId: 'school-a',
  });
  assert.deepEqual(requests, [{
    url: 'http://auth:3001/api/auth/internal/students/student-a?schoolId=school-a',
    options: { headers: { 'X-Internal-Service-Token': 'shared-token' } },
  }]);
});

test('maps a not-found student to null but rejects an invalid Auth projection', async () => {
  const missing = createAuthStudentDirectory({
    baseUrl: 'http://auth', internalServiceToken: 'token', fetchImpl: async () => response(404, {}),
  });
  assert.equal(await missing.findStudentInSchool('student-a', 'school-a'), null);

  const invalid = createAuthStudentDirectory({
    baseUrl: 'http://auth', internalServiceToken: 'token',
    fetchImpl: async () => response(200, { studentId: 'different', schoolId: 'school-a' }),
  });
  await assert.rejects(
    invalid.findStudentInSchool('student-a', 'school-a'),
    AuthDirectoryUnavailable,
  );
});

test('preserves the Auth cross-school forbidden result', async () => {
  const directory = createAuthStudentDirectory({
    baseUrl: 'http://auth', internalServiceToken: 'token', fetchImpl: async () => response(403, {}),
  });
  assert.deepEqual(await directory.findStudentInSchool('student-a', 'school-a'), { forbidden: true });
});

test('lists only Auth-owned student IDs for one school', async () => {
  const directory = createAuthStudentDirectory({
    baseUrl: 'http://auth', internalServiceToken: 'token',
    fetchImpl: async () => response(200, { studentIds: ['student-a', 'student-b'] }),
  });
  assert.deepEqual(await directory.listStudentIdsInSchool('school-a'), ['student-a', 'student-b']);
});
