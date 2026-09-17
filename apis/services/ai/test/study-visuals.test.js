const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStudyVisualPrompt,
  studyVisualPlan,
  subjectVisualProfile,
  visualKeyFor,
} = require('../study-visuals');

const base = {
  studentId: '11111111-1111-1111-1111-111111111111',
  documentId: '22222222-2222-2222-2222-222222222222',
  learningVersionId: '33333333-3333-3333-3333-333333333333',
  contentFingerprint: 'fp-2026',
  subject: 'Mathematics',
  chapterName: 'Coordinate geometry',
  theme: 'dark',
  state: 'active',
};

test('subject profiles remain abstract and educationally distinct', () => {
  assert.equal(subjectVisualProfile('Mathematics').key, 'mathematics');
  assert.equal(subjectVisualProfile('World History').key, 'social-studies');
  assert.equal(subjectVisualProfile('Computer Science').key, 'technology');
  assert.notEqual(subjectVisualProfile('Literature').palette, subjectVisualProfile('Mathematics').palette);
});

test('visual plans are deterministic for a published chapter identity', () => {
  const first = studyVisualPlan(base);
  const second = studyVisualPlan({ ...base });
  assert.deepEqual(first, second);
  assert.match(first.visualKey, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(first.seed));
  assert.ok(first.seed >= 0);
});

test('theme and state change the cache key without using learner content', () => {
  const active = visualKeyFor(base);
  const resume = visualKeyFor({ ...base, state: 'resume' });
  const light = visualKeyFor({ ...base, theme: 'light' });
  assert.notEqual(active, resume);
  assert.notEqual(active, light);

  const prompt = buildStudyVisualPrompt(base);
  assert.match(prompt, /no text/i);
  assert.match(prompt, /do not use gradients/i);
  assert.match(prompt, /no people/i);
  assert.match(prompt, /Coordinate geometry/);
  assert.doesNotMatch(prompt, /11111111-1111/);
});

test('unknown subjects use a stable general profile', () => {
  const prompt = buildStudyVisualPrompt({ ...base, subject: 'Advisory', chapterName: '' });
  assert.match(prompt, /Subject family: general/i);
  assert.match(prompt, /layered learning paths/i);
});
