'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalKey, resolveTopicKey, singularise, topicFromLabel, createVocabulary,
  SEED_TOPICS, normaliseCluster,
} = require('../interest/vocab');

function matchesText(vocab, key, text) {
  const matcher = vocab.matchers().find(m => m.key === key);
  return matcher.res.some(re => re.test(text));
}

test('canonicalKey is a pure, stable function of the label', () => {
  assert.equal(canonicalKey('Rock Climbing'), canonicalKey('rock climbing'));
  assert.equal(canonicalKey('  Rock   Climbing  '), 'rock-climbing');
  assert.equal(canonicalKey('Café Culture'), 'cafe-culture');
  assert.equal(canonicalKey("Formula 1's season"), 'formula-1s-season');
  assert.equal(canonicalKey(''), '');
  assert.equal(canonicalKey(null), '');
});

test('the long-tail interests the closed taxonomy could not hold now collapse onto one key', () => {
  // These are the exact examples that motivated the open vocabulary.
  for (const label of ['Drones', 'drone', 'FPV drones', 'UAV', 'quadcopter', 'Drone racing']) {
    assert.equal(canonicalKey(label), 'drones', `${label} should canonicalise to drones`);
  }
  for (const label of ['3D printing', '3D printer', '3d print', 'additive manufacturing', 'FDM', 'resin printing']) {
    assert.equal(canonicalKey(label), '3d-printing', `${label} should canonicalise to 3d-printing`);
  }
  for (const label of ['Rock climbing', 'bouldering', 'Climbing', 'sport climbing']) {
    assert.equal(canonicalKey(label), 'rock-climbing', `${label} should canonicalise to rock-climbing`);
  }
  for (const label of ['Defence technology', 'Defense Tech', 'military technology']) {
    assert.equal(canonicalKey(label), 'defence-tech', `${label} should canonicalise to defence-tech`);
  }
});

test('every seed key survives canonicalisation unchanged', () => {
  // The one-time legacy import maps ai_db nodes onto these keys by name. If the
  // singulariser ever rewrote one ('sports' -> 'sport'), every student's
  // imported node would silently orphan.
  for (const topic of SEED_TOPICS) {
    assert.equal(canonicalKey(topic.key), topic.key, `seed key ${topic.key} must be its own canonical form`);
  }
});

test('singularise leaves words that only look plural alone', () => {
  assert.equal(singularise('physics'), 'physics');
  assert.equal(singularise('business'), 'business');
  assert.equal(singularise('robotics'), 'robotics');
  assert.equal(singularise('analysis'), 'analysis');
  assert.equal(singularise('bus'), 'bus');
  assert.equal(singularise('drones'), 'drone');
  assert.equal(singularise('batteries'), 'battery');
  assert.equal(singularise('boxes'), 'box');
});

test('topicFromLabel derives match terms without anyone hand-writing them', () => {
  const topic = topicFromLabel('Drones', null);
  assert.equal(topic.key, 'drones');
  assert.equal(topic.cluster, 'other');       // unknown cluster falls back, never throws
  assert.ok(topic.terms.includes('quadcopter'), 'aliases pointing at the key become match terms');
  assert.ok(topic.terms.includes('uav'));
});

test('compiled matchers respect both word boundaries, not just the left one', () => {
  // Regression for known-risk #8: (^|[^a-z])term with no right boundary let
  // 'ai' match inside 'aircraft'. Uses a synthetic topic with a bare short
  // term — the real seed 'ai' topic already works around this by padding its
  // term with spaces (' ai '), which would mask the bug in this test.
  const vocab = createVocabulary([
    { key: 'cats', label: 'Cats', cluster: 'other', terms: ['cat'] },
  ]);
  assert.ok(matchesText(vocab, 'cats', 'my cat is asleep'), 'must still match the bare word');
  assert.ok(matchesText(vocab, 'cats', 'Cat!'), 'case-insensitive and punctuation-adjacent');
  assert.equal(matchesText(vocab, 'cats', 'the new product catalog is out'), false, 'must not match inside "catalog"');
  assert.equal(matchesText(vocab, 'cats', 'this concert was a catastrophe'), false, 'must not match inside "catastrophe"');
});

test('an unknown cluster is normalised rather than trusted', () => {
  assert.equal(normaliseCluster('science'), 'science');
  assert.equal(normaliseCluster('SCIENCE'), 'science');
  assert.equal(normaliseCluster('vibes'), 'other');
  assert.equal(normaliseCluster(undefined), 'other');
});

test('a vocabulary grows in place and matches the new topic immediately', () => {
  const vocab = createVocabulary();
  const before = vocab.size();
  assert.equal(vocab.has('rock-climbing'), false);

  vocab.add(topicFromLabel('Rock climbing', 'other'));
  assert.equal(vocab.size(), before + 1);
  assert.equal(vocab.labelOf('rock-climbing'), 'Rock climbing');

  const matcher = vocab.matchers().find(m => m.key === 'rock-climbing');
  assert.ok(matcher, 'a compiled matcher exists for the new topic');
  assert.ok(matcher.res.some(re => re.test(' a bouldering competition ')));
});

test('a blocked topic is stored but never matched', () => {
  const vocab = createVocabulary();
  vocab.add({ key: 'banned-thing', label: 'Banned', cluster: 'other', terms: ['banned thing'], status: 'blocked' });
  assert.equal(vocab.has('banned-thing'), true);
  assert.equal(vocab.matchers().some(m => m.key === 'banned-thing'), false);
});

test('re-adding a topic replaces its matcher rather than stacking a second one', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));
  vocab.add(topicFromLabel('Drones', 'tech'));
  assert.equal(vocab.matchers().filter(m => m.key === 'drones').length, 1);
});

test('resolveTopicKey returns the canonical key unchanged when it already exists', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));
  assert.equal(resolveTopicKey('Drones', vocab), 'drones');
  assert.equal(resolveTopicKey('drone', vocab), 'drones', 'still routed through canonicalKey first');
});

test('resolveTopicKey merges a near-duplicate onto the one existing topic whose terms match', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));
  assert.equal(resolveTopicKey('Quadcopter racing', vocab), 'drones');
});

test('resolveTopicKey mints a new key when nothing in the vocabulary matches', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));
  assert.equal(resolveTopicKey('Competitive origami', vocab), 'competitive-origami');
});

test('resolveTopicKey mints a new key on an ambiguous match rather than guessing', () => {
  const vocab = createVocabulary();
  vocab.add({ key: 'topic-a', label: 'Topic A', cluster: 'other', terms: ['shared term'], status: 'active' });
  vocab.add({ key: 'topic-b', label: 'Topic B', cluster: 'other', terms: ['shared term'], status: 'active' });
  assert.equal(resolveTopicKey('Shared term', vocab), 'shared-term', 'two topics match — never picks one silently');
});

test('resolveTopicKey never merges onto a blocked topic', () => {
  const vocab = createVocabulary();
  // Key deliberately differs from the label's own canonical form, so the
  // early "already exists" return can't mask whether the matcher scan (which
  // excludes blocked topics) is actually being consulted.
  vocab.add({ key: 'nasty-stuff', label: 'Nasty', cluster: 'other', terms: ['banned thing'], status: 'blocked' });
  assert.equal(resolveTopicKey('Banned thing stuff', vocab), 'banned-thing-stuff', 'a blocked topic has no live matcher to merge onto');
});

test('resolveTopicKey falls back to a bare canonicalKey call with no vocabulary', () => {
  assert.equal(resolveTopicKey('Quadcopter racing', null), canonicalKey('Quadcopter racing'));
});
