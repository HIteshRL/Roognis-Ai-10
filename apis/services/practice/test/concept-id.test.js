'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conceptIdForTag } = require('../concept-id');

test('practice and flashcard concept identity is stable across presentation changes', () => {
  assert.equal(conceptIdForTag('Photosynthesis: Basics'), conceptIdForTag('photosynthesis basics'));
  assert.equal(conceptIdForTag('Photosynthesis: Basics'), 'concept:v1:photosynthesis-basics');
});
