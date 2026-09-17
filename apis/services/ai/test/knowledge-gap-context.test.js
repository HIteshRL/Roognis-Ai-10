'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKnowledgeGapContext, formatKnowledgeGapContextForPrompt } = require('../knowledge-gap-context');

test('normalizes only bounded stable academic snapshot fields', () => {
  const result = normalizeKnowledgeGapContext({ knowledgeGaps: [{
    conceptId: 'concept:v1:fractions', mastery: 0.4, difficultyReadiness: 0.3,
    confidence: 0.8, nextDifficulty: 'simple', scaffold: 'worked_example',
    evidenceCount: 5, decisionSource: 'baseline', rawAnswer: 'must not pass',
  }] });
  assert.equal(result.length, 1);
  assert.equal(result[0].conceptId, 'concept:v1:fractions');
  assert.equal('rawAnswer' in result[0], false);
});

test('prompt explicitly prevents grading use', () => {
  const text = formatKnowledgeGapContextForPrompt({ knowledgeGaps: [{
    conceptId: 'concept:v1:fractions', mastery: 0.4, difficultyReadiness: 0.3,
    confidence: 0.8, nextDifficulty: 'simple', scaffold: 'worked_example', evidenceCount: 5,
  }] });
  assert.match(text, /Never use it to determine correctness, marks, or grades/);
});
test('loader normalization survives prompt formatting without dropping readiness', () => {
  const { normalizeKnowledgeGapContext, formatKnowledgeGapContextForPrompt } = require('../knowledge-gap-context');
  const normalized = normalizeKnowledgeGapContext({ knowledgeGaps: [{
    conceptId: 'fractions', mastery: 0.2, difficultyReadiness: 0.3, confidence: 0.8,
    nextDifficulty: 'simple', scaffold: 'worked_example', evidenceCount: 5, decisionSource: 'baseline',
  }] });
  assert.match(formatKnowledgeGapContextForPrompt({ knowledgeGaps: normalized }), /fractions.*worked_example/);
});
