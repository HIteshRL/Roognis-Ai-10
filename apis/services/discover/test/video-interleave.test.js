'use strict';
// Post-ranking video insertion — a structural mirror of
// test/cards-interleave.test.js's interleaveMicroArticles tests. The one rule
// that matters: a video is always sandwiched between two articles, counting
// only 'article'-kind entries toward the cadence (micro-article cards already
// threaded in do not count), and never leads the feed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { interleaveVideos } = require('../video/interleave');

function article(id) { return { kind: 'article', article: { id } }; }
function card(id) { return { kind: 'micro_article', card: { id } }; }
function videoRow(id) { return { id }; }

test('inserts a video before every 8th article by absolute position, never before the very first', () => {
  const items = Array.from({ length: 17 }, (_, i) => article(`a${i}`)); // absolute indices 0..16
  const queue = [videoRow('v1'), videoRow('v2')];
  const result = interleaveVideos(items, queue, { everyN: 8, startIndex: 0 });

  // Insertion points are before absolute article index 8 and index 16 (both
  // > 0 and divisible by everyN=8) — i.e. after 8 articles, then after 8 more.
  const kinds = result.map(i => i.kind);
  assert.deepEqual(kinds, [
    'article', 'article', 'article', 'article', 'article', 'article', 'article', 'article', 'video',
    'article', 'article', 'article', 'article', 'article', 'article', 'article', 'article', 'video',
    'article',
  ]);
  assert.deepEqual(result.filter(i => i.kind === 'video').map(i => i.video.id), ['v1', 'v2']);
});

test('a video never lands adjacent to the very first article, i.e. never leads the feed', () => {
  const items = Array.from({ length: 3 }, (_, i) => article(`a${i}`));
  const queue = [videoRow('v1')];
  const result = interleaveVideos(items, queue, { everyN: 1, startIndex: 0 });
  // everyN=1 would insert before every article except index 0 — confirm index
  // 0 specifically is protected even at the most aggressive cadence.
  assert.equal(result[0].kind, 'article');
  assert.equal(result[0].article.id, 'a0');
});

test('micro-article cards already in the stream are skipped, not counted, toward the video cadence', () => {
  // 3 articles with a card threaded after the 2nd (as interleaveMicroArticles
  // would produce) — the card must not itself count as the 3rd "article" when
  // deciding where the 8th real article cadence point falls.
  const items = [article('a0'), article('a1'), card('c1'), article('a2')];
  const queue = [videoRow('v1')];
  const result = interleaveVideos(items, queue, { everyN: 2, startIndex: 0 });
  // Cadence counts only articles: a0(idx0), a1(idx1) -> hit before a2(idx2).
  const kinds = result.map(i => i.kind);
  assert.deepEqual(kinds, ['article', 'article', 'micro_article', 'video', 'article']);
});

test('startIndex keeps a video landing at the same absolute position across pages', () => {
  const queueOf = () => [videoRow('p1'), videoRow('p2')];

  // Page 1: absolute indices 0..3 (everyN=4). No insertion point (index 0 excluded).
  const page1 = interleaveVideos(Array.from({ length: 4 }, (_, i) => article(`a${i}`)), queueOf(), { everyN: 4, startIndex: 0 });
  assert.equal(page1.filter(i => i.kind === 'video').length, 0);

  // Page 2: absolute indices 4..7. Index 4 is a hit.
  const page2 = interleaveVideos(Array.from({ length: 4 }, (_, i) => article(`b${i}`)), queueOf(), { everyN: 4, startIndex: 4 });
  assert.deepEqual(page2.map(i => i.kind), ['video', 'article', 'article', 'article', 'article']);
});

test('an empty video queue is a no-op — every item stays exactly as given, no errors', () => {
  const items = [article('a0'), card('c1'), article('a1')];
  const result = interleaveVideos(items, [], { everyN: 1, startIndex: 0 });
  assert.deepEqual(result, items);
});

test('a queue smaller than the number of insertion slots leaves the remaining slots as plain articles', () => {
  const items = Array.from({ length: 20 }, (_, i) => article(`a${i}`)); // slots at absolute 8, 16
  const queue = [videoRow('only-one')];
  const result = interleaveVideos(items, queue, { everyN: 8, startIndex: 0 });
  const videos = result.filter(i => i.kind === 'video');
  assert.equal(videos.length, 1);
  assert.equal(videos[0].video.id, 'only-one');
  assert.deepEqual(result.filter(i => i.kind === 'article').map(i => i.article.id), items.map(i => i.article.id));
});

test('missing items or queue arguments degrade to empty/unchanged rather than throwing', () => {
  assert.deepEqual(interleaveVideos(undefined, undefined), []);
  assert.deepEqual(interleaveVideos([], undefined), []);
});

test('default options (everyN=8, startIndex=0) match an explicit call', () => {
  const items = Array.from({ length: 10 }, (_, i) => article(`a${i}`));
  const queue = [videoRow('v1')];
  const withDefaults = interleaveVideos(items, queue);
  const explicit = interleaveVideos(items, queue, { everyN: 8, startIndex: 0 });
  assert.deepEqual(withDefaults, explicit);
});
