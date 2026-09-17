'use strict';

const { extractTopics } = require('../interest/graph');
const { canonicalKey, topicFromLabel } = require('../interest/vocab');

const POSITIVE_PATTERNS = [
  /\bi\s+(?:really\s+)?(?:like|love|enjoy|prefer)\s+([^.!?]{2,80})/gi,
  /\bi(?:'m| am)\s+(?:really\s+)?interested in\s+([^.!?]{2,80})/gi,
  /\buse\s+([^.!?]{2,60})\s+(?:examples|analogies)\b/gi,
];
const NEGATIVE_PATTERNS = [
  /\bi\s+(?:really\s+)?(?:dislike|hate)\s+([^.!?]{2,80})/gi,
  /\bi\s+(?:do not|don't)\s+like\s+([^.!?]{2,80})/gi,
  /\bi(?:'m| am)\s+not\s+interested in\s+([^.!?]{2,80})/gi,
];

function cleanPhrase(value) {
  return String(value || '')
    .replace(/\b(?:because|but|although|when|for my|in this)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function matchesFromPatterns(text, patterns, stance) {
  const rows = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const phrase = cleanPhrase(match[1]);
      if (phrase) rows.push({ phrase, stance });
      if (rows.length >= 4) return rows;
    }
  }
  return rows;
}

/**
 * Extract only explicit first-person preferences from tutor text. Merely
 * mentioning a topic is intentionally insufficient: a school question about
 * photosynthesis is not evidence that the student likes botany.
 */
function extractExplicitPreferences(text, vocab) {
  const cleaned = String(text || '').slice(0, 12000)
    .replace(/\u2019/g, "'")
    .replace(/"[^"]*"|“[^”]*”/g, '');
  const phrases = [
    ...matchesFromPatterns(cleaned, POSITIVE_PATTERNS, 'LIKE'),
    ...matchesFromPatterns(cleaned, NEGATIVE_PATTERNS, 'DISLIKE'),
  ];
  const output = new Map();
  for (const item of phrases) {
    const topics = extractTopics({ title: '', summary: item.phrase }, vocab);
    if (topics.length) {
      for (const topic of topics.slice(0, 3)) {
        output.set(topic.key, { topicKey: topic.key, stance: item.stance, confidence: 0.9, label: vocab.labelOf(topic.key) });
      }
      continue;
    }
    const topic = topicFromLabel(item.phrase, 'other');
    if (topic && canonicalKey(topic.key)) {
      output.set(topic.key, { topicKey: topic.key, stance: item.stance, confidence: 0.82, label: topic.label, proposedTopic: topic });
    }
  }
  return [...output.values()];
}

module.exports = { extractExplicitPreferences, cleanPhrase };
