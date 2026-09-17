'use strict';

// Deterministic rollups over a student's tutor conversations.
//
// This is the read side of "the chat log is an asset". It answers what a
// learner has been asking about — which chapters, which topics, which questions
// they keep coming back to — without an LLM anywhere in the path, so nothing
// here can change what, when, how, or how hard the system teaches.
//
// Extraction reuses `interest-graph.js`'s matchers rather than growing a second
// vocabulary. That file already defines what a topic and an entity are for this
// product, and two competing definitions would drift.

const { extractTopics, extractEntities, TOPIC_BY_KEY } = require('./interest-graph');

const MAX_TOPICS = 12;
const MAX_ENTITIES = 15;
const MAX_RECURRING = 10;
const MIN_RECURRING_COUNT = 2;

/**
 * The matchers read `{title, summary}` because they were written for news
 * articles. A chat message has neither, so it goes in as the summary — the
 * haystack is title + summary, so this loses nothing.
 */
function asDocument(text) {
  return { title: '', summary: String(text || '') };
}

/** Collapse a question to a comparison key: casing and punctuation are noise. */
function questionKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chapterKeyOf(session) {
  return [
    String(session.subject || '').toLowerCase(),
    Number(session.grade || 0),
    Number(session.chapterNumber || 0),
    String(session.chapterName || '').toLowerCase(),
  ].join('|');
}

function increment(map, key, seed) {
  if (!map.has(key)) map.set(key, { ...seed, count: 0 });
  const entry = map.get(key);
  entry.count += 1;
  return entry;
}

function sortedByCount(map, limit) {
  return [...map.values()]
    .sort((a, b) => (b.count - a.count) || String(a.key || a.label || '').localeCompare(String(b.key || b.label || '')))
    .slice(0, limit);
}

/**
 * Roll up sessions into insights.
 *
 * `sessions` are plain rows — `{id, subject, grade, board, curriculum,
 * chapterNumber, chapterName, createdAt, messages:[{role, content, createdAt}]}`
 * — so this is testable without a database.
 *
 * Only `user` messages feed the topic and entity rollups. Assistant replies are
 * this system's own output; counting them would measure the tutor's vocabulary
 * back to itself and drown out what the learner actually asked.
 */
function summariseChatHistory(sessions = [], options = {}) {
  const topics = new Map();
  const entities = new Map();
  const subjects = new Map();
  const chapters = new Map();
  const recurring = new Map();

  let questionCount = 0;
  let messageCount = 0;
  let firstAt = null;
  let lastAt = null;

  const sessionSummaries = [];

  for (const session of sessions) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const questions = messages.filter(message => message.role === 'user');
    messageCount += messages.length;
    questionCount += questions.length;

    const sessionTopics = new Map();

    for (const question of questions) {
      const document = asDocument(question.content);

      for (const topic of extractTopics(document)) {
        const entry = increment(topics, topic.key, {
          key: topic.key,
          cluster: topic.cluster,
          // TOPIC_BY_KEY is a Map. This was property access, which always
          // yields undefined, so every topic silently reported its raw key
          // ('maths') where a reader expected a label ('Mathematics').
          label: TOPIC_BY_KEY.get(topic.key)?.label || topic.key,
        });
        entry.score = (entry.score || 0) + topic.score;
        increment(sessionTopics, topic.key, { key: topic.key });
      }

      for (const entity of extractEntities(document)) {
        increment(entities, entity.key, { key: entity.key, name: entity.name || entity.key });
      }

      const key = questionKey(question.content);
      if (key) {
        const entry = increment(recurring, key, { key, text: String(question.content || '').trim() });
        entry.lastAskedAt = question.createdAt || entry.lastAskedAt;
      }

      const at = question.createdAt ? new Date(question.createdAt) : null;
      if (at && !Number.isNaN(at.valueOf())) {
        if (!firstAt || at < firstAt) firstAt = at;
        if (!lastAt || at > lastAt) lastAt = at;
      }
    }

    const subjectName = session.subject || 'Unknown';
    const subjectEntry = increment(subjects, subjectName, { key: subjectName, subject: subjectName });
    subjectEntry.questionCount = (subjectEntry.questionCount || 0) + questions.length;

    const chapterEntry = increment(chapters, chapterKeyOf(session), {
      key: chapterKeyOf(session),
      subject: session.subject || null,
      grade: session.grade || null,
      chapterNumber: session.chapterNumber || null,
      chapterName: session.chapterName || null,
    });
    chapterEntry.questionCount = (chapterEntry.questionCount || 0) + questions.length;

    const latest = messages.length ? messages[messages.length - 1].createdAt : session.createdAt;
    sessionSummaries.push({
      sessionId: session.id,
      subject: session.subject || null,
      grade: session.grade || null,
      chapterNumber: session.chapterNumber || null,
      chapterName: session.chapterName || null,
      createdAt: session.createdAt || null,
      latestActivityAt: latest || null,
      messageCount: messages.length,
      questionCount: questions.length,
      topics: [...sessionTopics.keys()],
    });
  }

  return {
    window: {
      since: options.since || (firstAt ? firstAt.toISOString() : null),
      sessionCount: sessions.length,
      messageCount,
      questionCount,
      firstQuestionAt: firstAt ? firstAt.toISOString() : null,
      lastQuestionAt: lastAt ? lastAt.toISOString() : null,
    },
    subjects: sortedByCount(subjects, 20).map(entry => ({
      subject: entry.subject,
      sessionCount: entry.count,
      questionCount: entry.questionCount || 0,
    })),
    chapters: sortedByCount(chapters, 40).map(entry => ({
      subject: entry.subject,
      grade: entry.grade,
      chapterNumber: entry.chapterNumber,
      chapterName: entry.chapterName,
      sessionCount: entry.count,
      questionCount: entry.questionCount || 0,
    })),
    topics: sortedByCount(topics, MAX_TOPICS).map(entry => ({
      key: entry.key,
      label: entry.label,
      cluster: entry.cluster,
      questionCount: entry.count,
      score: entry.score || 0,
    })),
    entities: sortedByCount(entities, MAX_ENTITIES).map(entry => ({
      key: entry.key,
      name: entry.name,
      mentions: entry.count,
    })),
    // Asked more than once — the strongest available signal that something did
    // not land the first time.
    recurringQuestions: [...recurring.values()]
      .filter(entry => entry.count >= MIN_RECURRING_COUNT)
      .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
      .slice(0, MAX_RECURRING)
      .map(entry => ({ text: entry.text, askedCount: entry.count, lastAskedAt: entry.lastAskedAt || null })),
    sessions: sessionSummaries,
  };
}

module.exports = {
  MAX_TOPICS,
  MAX_ENTITIES,
  MAX_RECURRING,
  MIN_RECURRING_COUNT,
  questionKey,
  summariseChatHistory,
};
