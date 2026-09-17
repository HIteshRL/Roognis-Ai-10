'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPreferenceTrainingSamples,
  isReclaimableRefreshLease,
  trainPreferenceGnn,
} = require('../preference/refresh');

test('preference training removes the held-out edge from the graph itself', () => {
  // With the student as a real node, zeroing the baseline is not enough: leaving
  // the STUDENT_PREFERS edge in place lets the model read the answer straight
  // off the edge it is being asked to predict. The edge has to be gone.
  const samples = buildPreferenceTrainingSamples([{
    preferences: [
      { topicKey: 'space', stance: 'LIKE', muted: false },
      { topicKey: 'sport', stance: 'DISLIKE', muted: false },
    ],
    graph: {
      nodes: [
        { nodeId: 'student:a', nodeType: 'student', features: [1, 0, 0, 0], baselineScore: 0 },
        { nodeId: 'space', nodeType: 'topic', features: [1, 0, 0, 1], baselineScore: 0.9 },
        { nodeId: 'sport', nodeType: 'topic', features: [0, 1, 0, 1], baselineScore: -0.8 },
        { nodeId: 'article:1', nodeType: 'article', features: [0, 0, 1, 0], baselineScore: 0 },
      ],
      edges: [
        { fromId: 'student:a', toId: 'space', relationship: 'STUDENT_PREFERS', sign: 1, weight: 2 },
        { fromId: 'student:a', toId: 'sport', relationship: 'STUDENT_PREFERS', sign: -1, weight: 2 },
        { fromId: 'article:1', toId: 'space', relationship: 'CONTENT_COVERS', sign: 1, weight: 1 },
        { fromId: 'space', toId: 'sport', relationship: 'TOPIC_CO_OCCURS', sign: 1, weight: 1 },
      ],
    },
  }]);

  const space = samples.find(row => row.targetTopicId === 'space');
  assert.equal(space.targetStance, 'LIKE');
  assert.equal(space.nodes.find(row => row.nodeId === 'space').baselineScore, 0);

  // The student's own edge to the target is gone...
  assert.ok(!space.edges.some(e => e.relationship === 'STUDENT_PREFERS' && e.toId === 'space'));
  // ...while the surrounding structure the model must actually reason over stays.
  assert.ok(space.edges.some(e => e.relationship === 'CONTENT_COVERS' && e.toId === 'space'));
  assert.ok(space.edges.some(e => e.relationship === 'TOPIC_CO_OCCURS'));
  // A different topic's stance is not held out — only the target's.
  assert.ok(space.edges.some(e => e.relationship === 'STUDENT_PREFERS' && e.toId === 'sport'));

  const sport = samples.find(row => row.targetTopicId === 'sport');
  assert.equal(sport.targetStance, 'DISLIKE');
  assert.ok(!sport.edges.some(e => e.relationship === 'STUDENT_PREFERS' && e.toId === 'sport'));
});

test('preference training failures are non-fatal to daily refresh', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('worker down'); };
  try {
    const result = await trainPreferenceGnn({
      url: 'http://trainer', token: 'token', runKey: 'preference:2026-09-01', samples: [{}],
    });
    assert.deepEqual(result, { attempted: true, promoted: false, reason: 'trainer_unavailable' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('only an expired running refresh lease can be reclaimed', () => {
  const now = new Date('2026-09-01T12:00:00Z');
  assert.equal(isReclaimableRefreshLease({
    status: 'running', leaseExpiresAt: new Date('2026-09-01T11:59:59Z'),
  }, now), true);
  assert.equal(isReclaimableRefreshLease({
    status: 'running', leaseExpiresAt: new Date('2026-09-01T12:00:01Z'),
  }, now), false);
  assert.equal(isReclaimableRefreshLease({
    status: 'done', leaseExpiresAt: new Date('2026-09-01T11:59:59Z'),
  }, now), false);
});
