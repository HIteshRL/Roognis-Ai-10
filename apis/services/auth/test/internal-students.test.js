const test = require('node:test');
const assert = require('node:assert/strict');

const { createInternalStudentHandlers } = require('../routes/internal-students');

function response() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function handlersFor({ student = null, students = [] } = {}) {
  const calls = [];
  const prisma = {
    user: {
      findUnique: async (args) => { calls.push(['findUnique', args]); return student; },
      findMany: async (args) => { calls.push(['findMany', args]); return students; },
    },
  };
  return { ...createInternalStudentHandlers(prisma), calls };
}

test('attests only a student in the requested school and returns no PII', async () => {
  const { getStudentInSchool, calls } = handlersFor({
    student: { id: 'student-a', schoolId: 'school-a', role: 'student' },
  });
  const res = response();

  await getStudentInSchool({ params: { studentId: 'student-a' }, query: { schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { studentId: 'student-a', schoolId: 'school-a' });
  assert.deepEqual(calls[0][1], {
    where: { id: 'student-a' },
    select: { id: true, schoolId: true, role: true },
  });
});

test('does not disclose a missing or non-student principal', async () => {
  const { getStudentInSchool } = handlersFor();
  const res = response();

  await getStudentInSchool({ params: { studentId: 'student-a' }, query: { schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Student not found.' });
});

test('preserves the authorization distinction for a student in another school', async () => {
  const { getStudentInSchool } = handlersFor({ student: { id: 'student-a', schoolId: 'school-b', role: 'student' } });
  const res = response();

  await getStudentInSchool({ params: { studentId: 'student-a' }, query: { schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Forbidden.' });
});

test('lists only ordered student IDs for one school', async () => {
  const { listStudentIdsInSchool, calls } = handlersFor({
    students: [{ id: 'student-a' }, { id: 'student-b' }],
  });
  const res = response();

  await listStudentIdsInSchool({ params: { schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { studentIds: ['student-a', 'student-b'] });
  assert.deepEqual(calls[0][1], {
    where: { schoolId: 'school-a', role: 'student' },
    select: { id: true },
    orderBy: { name: 'asc' },
  });
});
