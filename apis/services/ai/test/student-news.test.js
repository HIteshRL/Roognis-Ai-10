const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRssFeed,
  isStudentSafeNews,
  selectStudentNews,
  balanceNewsCategories,
  areSimilarNewsStories,
  extractOriginalImageUrl,
} = require('../student-news');

const FEED = { key: 'science', name: 'Trusted Science', category: 'science' };

test('parses original RSS image, source fields, and description without generating media', () => {
  const xml = `
    <rss><channel><item>
      <title><![CDATA[Students test a new Moon rover]]></title>
      <description><![CDATA[A school engineering team tested a rover for future exploration.]]></description>
      <link>https://example.org/moon-rover</link>
      <pubDate>Fri, 17 Jul 2026 08:00:00 GMT</pubDate>
      <media:thumbnail url="https://images.example.org/rover.jpg" />
    </item></channel></rss>`;
  const [article] = parseRssFeed(xml, FEED);
  assert.equal(article.title, 'Students test a new Moon rover');
  assert.equal(article.imageUrl, 'https://images.example.org/rover.jpg');
  assert.equal(article.sourceName, 'Trusted Science');
});

test('returns no image when the publisher supplies none', () => {
  assert.equal(extractOriginalImageUrl('<item><title>Text only</title></item>'), null);
});

test('blocks murder and graphic violence while allowing educational war diplomacy coverage', () => {
  assert.equal(isStudentSafeNews({ category: 'technology', title: 'Man murdered', summary: 'Police report' }), false);
  assert.equal(isStudentSafeNews({ category: 'science', title: 'One dead in floods', summary: 'Campers died nearby' }), false);
  assert.equal(isStudentSafeNews({
    category: 'world',
    title: 'Countries discuss peace agreement during war',
    summary: 'Students can understand how diplomacy works.',
  }), true);
});

test('world affairs requires constructive educational context', () => {
  assert.equal(isStudentSafeNews({ category: 'world', title: 'Political dispute grows', summary: 'Leaders trade claims.' }), false);
  assert.equal(isStudentSafeNews({ category: 'world', title: 'Leader accuses country of election meddling', summary: 'The claim may undermine an election.' }), false);
  assert.equal(isStudentSafeNews({ category: 'world', title: 'A couple paid off debt', summary: 'She said they share an account.' }), false);
  assert.equal(isStudentSafeNews({ category: 'world', title: 'Youth cooperation programme opens', summary: 'Students learn together.' }), true);
});

test('science and technology reject distressing or market-led stories', () => {
  assert.equal(isStudentSafeNews({ category: 'science', title: 'Heatwave continues', summary: 'Temperatures remain high.' }), false);
  assert.equal(isStudentSafeNews({ category: 'technology', title: 'Space company share price drops', summary: 'Stock market trading was volatile.' }), false);
  assert.equal(isStudentSafeNews({ category: 'science', title: 'Curlew chicks released', summary: 'A conservation project aims to boost species numbers.' }), true);
});

test('selects recent safe stories, removes duplicates, and keeps newest first', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const selected = selectStudentNews([
    { category: 'science', title: 'Older', summary: 'Space research', url: 'https://example.org/a', publishedAt: new Date('2026-07-15') },
    { category: 'science', title: 'Newest', summary: 'Space research', url: 'https://example.org/b', publishedAt: new Date('2026-07-17') },
    { category: 'science', title: 'Duplicate', summary: 'Space research', url: 'https://example.org/b?utm_source=x', publishedAt: new Date('2026-07-16') },
    { category: 'sports', title: 'Old result', summary: 'Tournament', url: 'https://example.org/c', publishedAt: new Date('2026-06-01') },
  ], { now });
  assert.deepEqual(selected.map(item => item.title), ['Newest', 'Older']);
});

test('recognizes separate articles about the same news event', () => {
  assert.equal(areSimilarNewsStories(
    { category: 'science', title: 'What we know about newly discovered monkey species' },
    { category: 'science', title: 'New monkey species with orange lips found in Congo forest' }
  ), true);
  assert.equal(areSimilarNewsStories(
    { category: 'science', title: 'Curlew chicks released to boost species numbers' },
    { category: 'science', title: 'New monkey species discovered in Congo forest' }
  ), false);
});

test('topic deduplication keeps only the newest article for a repeated event', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const selected = selectStudentNews([
    { category: 'science', title: 'New monkey species discovered in Congo', summary: 'A science discovery', url: 'https://example.org/monkey-new', publishedAt: new Date('2026-07-17') },
    { category: 'science', title: 'Watch: newly discovered monkey species explained', summary: 'A science discovery', url: 'https://example.org/monkey-old', publishedAt: new Date('2026-07-16') },
  ], { now });
  assert.deepEqual(selected.map(item => item.title), ['New monkey species discovered in Congo']);
});

test('balances categories so a busy sports feed cannot crowd out educational stories', () => {
  // Dated fixtures: rounds are ordered by recency, so undated articles would
  // compare as NaN and make this assertion non-deterministic.
  const at = iso => new Date(iso);
  const articles = [
    { category: 'sports', title: 'Sport 1', publishedAt: at('2026-07-17T10:00:00Z') },
    { category: 'sports', title: 'Sport 2', publishedAt: at('2026-07-17T09:00:00Z') },
    { category: 'sports', title: 'Sport 3', publishedAt: at('2026-07-17T08:00:00Z') },
    { category: 'technology', title: 'Tech 1', publishedAt: at('2026-07-17T07:00:00Z') },
    { category: 'science', title: 'Science 1', publishedAt: at('2026-07-17T06:00:00Z') },
    { category: 'world', title: 'World 1', publishedAt: at('2026-07-17T05:00:00Z') },
  ];
  const titles = balanceNewsCategories(articles, 5).map(article => article.title);

  // Round one takes the newest of every category before any category repeats,
  // so all four categories appear before the second sports story.
  assert.deepEqual(titles, ['Sport 1', 'Tech 1', 'Science 1', 'World 1', 'Sport 2']);
  const sportsInFirstFour = titles.slice(0, 4).filter(t => t.startsWith('Sport')).length;
  assert.equal(sportsInFirstFour, 1, 'a busy feed may not take more than one of the first four slots');
});
