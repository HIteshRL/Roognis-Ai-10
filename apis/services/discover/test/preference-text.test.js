'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVocabulary } = require('../interest/vocab');
const { extractExplicitPreferences } = require('../preference/text-extract');

test('extracts explicit tutor-chat likes and dislikes', () => {
  const vocab = createVocabulary();
  const likes = extractExplicitPreferences('I love space and I do not like football.', vocab);
  assert.equal(likes.find(item => item.topicKey === 'space')?.stance, 'LIKE');
  assert.equal(likes.find(item => item.topicKey === 'football')?.stance, 'DISLIKE');
});

test('does not treat an academic topic mention as a preference', () => {
  const vocab = createVocabulary();
  assert.deepEqual(extractExplicitPreferences('Explain photosynthesis for my homework.', vocab), []);
});
