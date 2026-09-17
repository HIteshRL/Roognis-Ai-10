'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summariseChatHistory, questionKey } = require('../chat-insights');

/* ── What these protect ──────────────────────────────────────────────────────
   These rollups are what other services will build on, so the shape and the
   counting rules matter more than the exact vocabulary. The load-bearing rule
   is that assistant replies never feed the rollups: counting them measures the
   tutor's own output back to itself and buries what the learner asked.    ── */

const AT = n => new Date(`2026-08-0${n}T12:00:00.000Z`);

function session(overrides = {}) {
  return {
    id: 'session-1',
    subject: 'Science',
    grade: 8,
    board: 'CBSE',
    curriculum: 'NCERT',
    chapterNumber: 3,
    chapterName: 'Coal and Petroleum',
    createdAt: AT(1),
    messages: [],
    ...overrides,
  };
}

const ask = (content, at = AT(1)) => ({ role: 'user', content, createdAt: at });
const reply = (content, at = AT(1)) => ({ role: 'assistant', content, createdAt: at });

test('an empty history summarises to zeroes rather than throwing', () => {
  const insights = summariseChatHistory([]);
  assert.equal(insights.window.sessionCount, 0);
  assert.equal(insights.window.questionCount, 0);
  assert.deepEqual(insights.topics, []);
  assert.deepEqual(insights.recurringQuestions, []);
});

test('questions are counted, assistant replies are not', () => {
  const insights = summariseChatHistory([
    session({ messages: [ask('Why is coal a fossil fuel?'), reply('Because...'), ask('And petroleum?')] }),
  ]);
  assert.equal(insights.window.questionCount, 2);
  assert.equal(insights.window.messageCount, 3);
});

test('topics are extracted only from what the student asked', () => {
  // The reply is dense with space vocabulary; the question has none. If the
  // rollup picked up the reply, this would surface a topic the learner never
  // raised, and downstream personalisation would chase the tutor's own words.
  const insights = summariseChatHistory([
    session({
      messages: [
        ask('How do I balance this equation?'),
        reply('Think of it like a rocket launch into space, orbiting a planet in the solar system.'),
      ],
    }),
  ]);
  assert.ok(
    !insights.topics.some(topic => topic.key === 'space'),
    `assistant vocabulary leaked into topics: ${insights.topics.map(t => t.key).join(', ')}`
  );
});

test('chapters roll up with their question counts', () => {
  const insights = summariseChatHistory([
    session({ id: 's1', messages: [ask('q1'), ask('q2')] }),
    session({ id: 's2', messages: [ask('q3')] }),
    session({
      id: 's3',
      subject: 'Mathematics',
      chapterNumber: 6,
      chapterName: 'Power Play',
      messages: [ask('q4')],
    }),
  ]);

  assert.equal(insights.chapters.length, 2);
  const coal = insights.chapters.find(c => c.chapterName === 'Coal and Petroleum');
  assert.equal(coal.sessionCount, 2);
  assert.equal(coal.questionCount, 3);
});

test('repeated questions surface, one-offs do not', () => {
  const insights = summariseChatHistory([
    session({
      messages: [
        ask('What is a polymer?'),
        ask('what is a POLYMER??'),
        ask('  What is a polymer  '),
        ask('Something asked once'),
      ],
    }),
  ]);

  assert.equal(insights.recurringQuestions.length, 1);
  assert.equal(insights.recurringQuestions[0].askedCount, 3);
});

test('question keys ignore casing and punctuation but not wording', () => {
  assert.equal(questionKey('What is a polymer?'), questionKey('  what IS a Polymer!! '));
  assert.notEqual(questionKey('What is a polymer?'), questionKey('What is a molecule?'));
});

test('the window spans the first and last question', () => {
  const insights = summariseChatHistory([
    session({ id: 's1', messages: [ask('early', AT(1))] }),
    session({ id: 's2', messages: [ask('late', AT(9))] }),
  ]);
  assert.equal(insights.window.firstQuestionAt, AT(1).toISOString());
  assert.equal(insights.window.lastQuestionAt, AT(9).toISOString());
});

test('every session is summarised even when it holds no questions', () => {
  // A session created but never used still exists, and a consumer counting
  // sessions must not silently disagree with the sessions list.
  const insights = summariseChatHistory([session({ id: 'empty', messages: [] })]);
  assert.equal(insights.sessions.length, 1);
  assert.equal(insights.sessions[0].questionCount, 0);
  assert.equal(insights.window.sessionCount, 1);
});

test('summarising is deterministic', () => {
  const rows = [session({ messages: [ask('Why does ice float on water?'), ask('Why does ice float on water?')] })];
  assert.deepEqual(summariseChatHistory(rows), summariseChatHistory(rows));
});
