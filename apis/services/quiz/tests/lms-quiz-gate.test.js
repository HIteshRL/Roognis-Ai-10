const test = require('node:test');
const assert = require('node:assert/strict');

// LMS_SERVICE_URL / INTERNAL_SERVICE_TOKEN are read once at module load, so
// they must be set before the require below — same reason
// student-learning.test.js and friends set env vars ahead of their imports.
process.env.LMS_SERVICE_URL = 'http://lms-test:3006';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';

const { checkQuizAccess, reportQuizScore, UNLINKED } = require('../lib/lms-quiz-gate');

function fakeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

test('checkQuizAccess returns the LMS payload verbatim on success', async () => {
  const payload = { linked: true, allowed: true, classroomId: 'c1', courseworkId: 'cw1', maxPoints: 20 };
  const result = await checkQuizAccess({ quizId: 'q1', studentId: 's1' }, fakeFetch(200, payload));
  assert.deepEqual(result, payload);
});

test('checkQuizAccess fails closed on network, HTTP and invalid responses', async () => {
  for (const fn of [async()=>{throw new Error('offline')}, fakeFetch(500,{error:'offline'}),fakeFetch(200,null)]) {
    await assert.rejects(checkQuizAccess({quizId:'q1',studentId:'s1'},fn),/authorization is unavailable/);
  }
});

test('reportQuizScore never throws, even when the fetch itself fails', () => {
  const throwingFetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.doesNotThrow(() => {
    reportQuizScore({ quizId: 'q1', studentId: 's1', score: 4, maxScore: 5, attemptId: 'a1' }, throwingFetch);
  });
});

test('reportQuizScore posts the expected payload to the internal endpoint', async () => {
  let captured = null;
  const fetchFn = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{}' };
  };

  reportQuizScore({ quizId: 'q1', studentId: 's1', score: 4, maxScore: 5, attemptId: 'a1' }, fetchFn);
  // Fire-and-forget — reportQuizScore doesn't return a promise the caller
  // awaits, so give the microtask queue one turn before asserting.
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(captured, 'fetch was called');
  assert.match(captured.url, /\/api\/lms\/internal\/quiz-score$/);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['X-Internal-Service-Token'], 'test-internal-token');
  assert.deepEqual(JSON.parse(captured.options.body), {
    quizId: 'q1',
    studentId: 's1',
    score: 4,
    maxScore: 5,
    attemptId: 'a1',
  });
});
