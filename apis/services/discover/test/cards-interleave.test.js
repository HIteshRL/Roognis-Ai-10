'use strict';
// cards/interleave.js — the post-ranking insertion pass that weaves
// micro-article cards into an already-ranked, already-paginated page of news
// articles. Pure function: no DB, no clock — every case here is plain arrays
// in, plain arrays out.

const test = require('node:test');
const assert = require('node:assert/strict');

const { interleaveMicroArticles } = require('../cards/interleave');

function article(id) {
  return { id, title: `Article ${id}` };
}

function card(id) {
  return { id, headline: `Card ${id}` };
}

function articles(n) {
  return Array.from({ length: n }, (_, i) => article(i));
}

test('inserts a card before every 4th article by absolute position, never before the very first', () => {
  const page = articles(13); // absolute indices 0..12, so index 12 is a valid third insertion point
  const queue = [card('a'), card('b'), card('c')];
  const items = interleaveMicroArticles(page, queue, { everyN: 4, startIndex: 0 });

  // Expected shape: art0-3, CARD, art4-7, CARD, art8-11, CARD, art12
  const types = items.map(i => i.kind);
  assert.deepEqual(types, [
    'article', 'article', 'article', 'article', 'micro_article',
    'article', 'article', 'article', 'article', 'micro_article',
    'article', 'article', 'article', 'article', 'micro_article',
    'article',
  ]);
  // Cards land right before the articles whose absolute index is 4, 8, 12.
  const cardPositions = items.reduce((acc, item, idx) => {
    if (item.kind === 'micro_article') acc.push(idx);
    return acc;
  }, []);
  assert.deepEqual(cardPositions, [4, 9, 14]);
  // Consumed in queue order.
  assert.deepEqual(items.filter(i => i.kind === 'micro_article').map(i => i.card.id), ['a', 'b', 'c']);
});

test('a different everyN changes cadence but keeps the same absolute-index rule', () => {
  const page = articles(6); // absolute indices 0..5
  const queue = [card('x'), card('y')];
  const items = interleaveMicroArticles(page, queue, { everyN: 2, startIndex: 0 });
  // Cards insert before absolute index 2 and 4.
  const types = items.map(i => i.kind);
  assert.deepEqual(types, [
    'article', 'article', 'micro_article',
    'article', 'article', 'micro_article',
    'article', 'article',
  ]);
});

test('startIndex keeps a card landing at the same absolute feed position across pages, not restarting the counter at 0', () => {
  const queue = () => [card('p1'), card('p2'), card('p3')];

  // Page 1: absolute indices 0..3 (limit=4). No insertion point (only index 0 hits %4===0, but 0 is excluded).
  const page1 = interleaveMicroArticles(articles(4), queue(), { everyN: 4, startIndex: 0 });
  assert.equal(page1.filter(i => i.kind === 'micro_article').length, 0);

  // Page 2: absolute indices 4..7. Index 4 is a hit (4 % 4 === 0, > 0).
  const page2 = interleaveMicroArticles(articles(4), queue(), { everyN: 4, startIndex: 4 });
  const p2Types = page2.map(i => i.kind);
  assert.deepEqual(p2Types, ['micro_article', 'article', 'article', 'article', 'article']);

  // Page 3: absolute indices 8..11. Index 8 is a hit.
  const page3 = interleaveMicroArticles(articles(4), queue(), { everyN: 4, startIndex: 8 });
  const p3Types = page3.map(i => i.kind);
  assert.deepEqual(p3Types, ['micro_article', 'article', 'article', 'article', 'article']);

  // A page that starts mid-cadence (startIndex=6) inserts at absolute index 8, i.e. the 3rd article of that page (offset 2).
  const page4 = interleaveMicroArticles(articles(4), queue(), { everyN: 4, startIndex: 6 });
  const p4Types = page4.map(i => i.kind);
  assert.deepEqual(p4Types, ['article', 'article', 'micro_article', 'article', 'article']);
});

test('an empty queue is a no-op — every item stays a plain article, no errors', () => {
  const page = articles(9);
  const items = interleaveMicroArticles(page, [], { everyN: 4, startIndex: 0 });
  assert.equal(items.length, 9);
  assert.ok(items.every(i => i.kind === 'article'));
  assert.deepEqual(items.map(i => i.article.id), page.map(a => a.id));
});

test('a queue smaller than the number of insertion slots leaves the remaining slots as plain articles', () => {
  const page = articles(12); // 3 insertion slots at absolute index 4, 8 (12 excluded — page ends at index 11)
  const queue = [card('only-one')];
  const items = interleaveMicroArticles(page, queue, { everyN: 4, startIndex: 0 });

  const cardItems = items.filter(i => i.kind === 'micro_article');
  assert.equal(cardItems.length, 1, 'only one card was available, so only one is used');
  assert.equal(cardItems[0].card.id, 'only-one');
  // All 12 articles are still present, in order, nothing dropped.
  assert.deepEqual(items.filter(i => i.kind === 'article').map(i => i.article.id), page.map(a => a.id));
});

test('missing newsPage or queue arguments degrade to empty arrays rather than throwing', () => {
  assert.deepEqual(interleaveMicroArticles(undefined, undefined), []);
  assert.deepEqual(interleaveMicroArticles([], undefined), []);
});

test('default options (everyN=4, startIndex=0) match an explicit call', () => {
  const page = articles(5);
  const queue = [card('d')];
  const withDefaults = interleaveMicroArticles(page, queue);
  const explicit = interleaveMicroArticles(page, queue, { everyN: 4, startIndex: 0 });
  assert.deepEqual(withDefaults, explicit);
});
