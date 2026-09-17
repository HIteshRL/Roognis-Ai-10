'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCurriculumLinks } = require('../lib/curriculum-links');
const edge = (fromConceptId, toConceptId) => ({ fromConceptId, toConceptId });
test('reviewed prerequisite links are directed, deduplicated and acyclic', () => {
  assert.deepEqual(validateCurriculumLinks([edge('a', 'b'), edge('a', 'b')], ['a', 'b']), [edge('a', 'b')]);
  assert.throws(() => validateCurriculumLinks([edge('a', 'outside')], ['a', 'b']), /reviewed/);
  assert.throws(() => validateCurriculumLinks([edge('a', 'a')], ['a']), /distinct/);
  assert.throws(() => validateCurriculumLinks([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], ['a', 'b', 'c']), /cycle/);
});
