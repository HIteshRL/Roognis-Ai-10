'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conceptIdForTag, misconceptionIdFor } = require('../lib/concept-id');

test('quiz concept IDs are stable and independent of punctuation or casing', () => {
  assert.equal(conceptIdForTag('Adding Fractions!'), conceptIdForTag('adding fractions'));
  assert.equal(conceptIdForTag('Adding Fractions!'), 'concept:v1:adding-fractions');
});

test('quiz concept IDs retain a deterministic identity for non-Latin labels', () => {
  const first = conceptIdForTag('भिन्न जोड़ना');
  assert.equal(first, conceptIdForTag('भिन्न जोड़ना'));
  assert.match(first, /^concept:v1:/);
});

test('rubric misconception IDs are stable and scoped to their concept', () => {
  const concept = conceptIdForTag('Adding fractions');
  const first = misconceptionIdFor(concept, 'Adds denominators directly');
  assert.equal(first, misconceptionIdFor(concept, 'adds denominators directly'));
  assert.notEqual(first, misconceptionIdFor(conceptIdForTag('Multiplying fractions'), 'adds denominators directly'));
  assert.match(first, /^misconception:v1:[a-f0-9]{32}$/);
});
