const test = require('node:test');
const assert = require('node:assert/strict');

const { createInternalParentLinkHandler } = require('../routes/internal-parent-link');

function response() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function handlerFor(users) {
  const calls = { upserts: [] };
  const prisma = {
    user: { findUnique: async ({ where: { id } }) => users[id] || null },
    parentStudent: {
      upsert: async (args) => { calls.upserts.push(args); },
    },
  };
  return { handler: createInternalParentLinkHandler(prisma), calls };
}

test('links same-school parent and student idempotently for LMS', async () => {
  const { handler, calls } = handlerFor({
    parent: { id: 'parent', role: 'parent', schoolId: 'school-a' },
    student: { id: 'student', role: 'student', schoolId: 'school-a' },
  });
  const res = response();

  await handler({ body: { parentId: 'parent', studentId: 'student', schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { message: 'Parent-student link established.' });
  assert.deepEqual(calls.upserts, [{
    where: { parentId_studentId: { parentId: 'parent', studentId: 'student' } },
    create: { parentId: 'parent', studentId: 'student' },
    update: {},
  }]);
});

test('rejects invalid roles and cross-school parent links before upserting', async () => {
  const { handler, calls } = handlerFor({
    parent: { id: 'parent', role: 'parent', schoolId: 'school-a' },
    student: { id: 'student', role: 'student', schoolId: 'school-b' },
  });
  const res = response();

  await handler({ body: { parentId: 'parent', studentId: 'student', schoolId: 'school-a' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /studentId does not reference a valid student account/);
  assert.deepEqual(calls.upserts, []);
});

test('requires the full LMS internal contract payload', async () => {
  const { handler, calls } = handlerFor({});
  const res = response();

  await handler({ body: { parentId: 'parent', studentId: 'student' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /parentId, studentId, and schoolId are required/);
  assert.deepEqual(calls.upserts, []);
});
