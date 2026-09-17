'use strict';
// interest/propose.js had zero direct unit coverage before this file. These
// tests exercise makeValidateProposals() directly — the pure validation path
// — rather than proposeInterests() itself, since the latter calls the live
// LLM seam and this service has no mocking infra for that (consistent with
// cards/generate.js's prompt-builder-only coverage).

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeValidateProposals } = require('../interest/propose');
const { createVocabulary, topicFromLabel } = require('../interest/vocab');

test('a proposal merges onto an existing topic whose terms already match it', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));

  const validate = makeValidateProposals(['https://x.test/a'], vocab);
  const out = validate({
    interests: [{ label: 'Quadcopter racing', cluster: 'tech', evidenceUrls: ['https://x.test/a'] }],
  });

  assert.equal(out[0].key, 'drones', 'resolves onto the existing topic instead of minting a near-duplicate');
});

test('an ambiguous or unmatched label still mints a fresh key, unchanged from today', () => {
  const vocab = createVocabulary();
  vocab.add(topicFromLabel('Drones', 'tech'));
  vocab.add(topicFromLabel('Rock climbing', 'other'));

  const validate = makeValidateProposals(['https://x.test/a'], vocab);
  const out = validate({
    interests: [{ label: 'Competitive origami', cluster: 'other', evidenceUrls: ['https://x.test/a'] }],
  });

  assert.equal(out[0].key, 'competitive-origami', 'no existing topic matches, so a new key is minted as before');
});

test('with no vocabulary supplied, behaviour is identical to a bare canonicalKey call', () => {
  const validate = makeValidateProposals(['https://x.test/a'], null);
  const out = validate({
    interests: [{ label: 'Quadcopter racing', cluster: 'tech', evidenceUrls: ['https://x.test/a'] }],
  });

  assert.equal(out[0].key, 'quadcopter-racing', 'no vocab means no merge path is available');
});

test('validation bounds are unaffected by the vocab parameter', () => {
  const vocab = createVocabulary();
  const validate = makeValidateProposals(['https://x.test/a'], vocab);

  assert.throws(() => validate({ interests: 'not-an-array' }), /must be an array/);
  assert.throws(
    () => validate({ interests: [{ label: 'Way too many words for a label here', cluster: 'other', evidenceUrls: [] }] }),
    /at most 4 words/,
  );
});
