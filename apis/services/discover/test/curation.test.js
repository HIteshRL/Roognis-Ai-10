'use strict';
// news/curation.js is a port of the safety/dedupe logic in
// services/ai/student-news.js. Like graph.test.js, this loads both and asserts
// they agree, so the port cannot have quietly weakened the gate that decides
// what a 13-year-old sees.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const curation = require('../news/curation');
const { parseRssFeed } = require('../search/rss');

let legacy = null;
try {
  legacy = require(path.join(__dirname, '..', '..', 'ai', 'student-news.js'));
} catch { /* predecessor removed — absolute assertions still apply */ }

const SAMPLES = [
  { category: 'sports',     title: 'India win the test match',                summary: 'A cricket innings to remember.' },
  { category: 'sports',     title: 'Man found dead after stadium shooting',   summary: 'Police confirm the death toll.' },
  { category: 'world',      title: 'Countries sign a climate agreement',      summary: 'The cooperation covers renewable energy.' },
  { category: 'world',      title: 'Border clashes continue',                 summary: 'Missiles were fired overnight.' },
  { category: 'world',      title: 'Prime minister meets counterpart',        summary: 'They spoke for an hour.' },
  { category: 'technology', title: 'New chip speeds up computing',            summary: 'The semiconductor helps research.' },
  { category: 'technology', title: 'Company rebrands',                        summary: 'A new logo was unveiled.' },
  { category: 'science',    title: 'Telescope makes a discovery',             summary: 'Scientists study a distant planet.' },
  { category: 'science',    title: 'Earthquake hits the coast',               summary: 'Thousands displaced.' },
  { category: 'education',  title: 'School opens a new library',              summary: 'Students helped design it.' },
  { category: 'india',      title: 'Scholarship exchange programme launches', summary: 'Youth development is the focus.' },
  { category: 'unknown',    title: 'Something happened',                      summary: 'Somewhere.' },
];

test('the safety gate agrees with the predecessor on every genre', () => {
  if (!legacy) return;
  for (const sample of SAMPLES) {
    assert.equal(
      curation.isStudentSafeNews(sample),
      legacy.isStudentSafeNews(sample),
      `verdict differs for [${sample.category}] "${sample.title}"`,
    );
  }
});

test('distressing material is blocked whatever genre it arrives under', () => {
  for (const category of ['sports', 'world', 'technology', 'science', 'education', 'interests']) {
    assert.equal(
      curation.isStudentSafeNews({ category, title: 'Man found dead after shooting', summary: 'The death toll rose.' }),
      false,
      `blocklist must apply to ${category}`,
    );
  }
});

test('general-news genres must earn inclusion, not merely avoid blocked words', () => {
  // A bland world story with no constructive framing is still excluded — this
  // is the gate that keeps the feed from becoming a wire service.
  assert.equal(curation.isStudentSafeNews({ category: 'world', title: 'Prime minister meets counterpart', summary: 'They spoke for an hour.' }), false);
  assert.equal(curation.isStudentSafeNews({ category: 'world', title: 'Countries sign a climate agreement', summary: 'Cooperation on renewable energy.' }), true);
});

test('hunted articles pass the blocklist but are not asked to sound cheerful', () => {
  // The constructive-framing gate exists because an untargeted world feed skews
  // to catastrophe. A query the student's own graph asked for is different:
  // requiring upbeat wording would empty the lane entirely.
  const dry = { category: 'interests', title: 'Regulator publishes new drone flight rules', summary: 'Operators must register above 250g.' };
  assert.equal(curation.isStudentSafeNews(dry), true);

  const unsafe = { category: 'interests', title: 'Drone strikes kill civilians', summary: 'The bombing continued.' };
  assert.equal(curation.isStudentSafeNews(unsafe), false, 'the blocklist still applies to the hunt lane');
});

test('empty or missing text is never safe by default', () => {
  assert.equal(curation.isStudentSafeNews({ category: 'sports', title: '', summary: '' }), false);
  assert.equal(curation.isStudentSafeNews({}), false);
  assert.equal(curation.isStudentSafeNews(null), false);
});

test('term matching respects word boundaries', () => {
  assert.equal(curation.includesNewsTerm(' the lawn was mowed ', 'law'), false);
  assert.equal(curation.includesNewsTerm(' a court of law today ', 'law'), true);
  if (legacy) {
    // includesNewsTerm is not exported by the predecessor; compare through the
    // public gate instead.
    const article = { category: 'sports', title: 'Groundskeeper mows the lawn', summary: 'A quiet afternoon.' };
    assert.equal(curation.isStudentSafeNews(article), legacy.isStudentSafeNews(article));
  }
});

test('near-duplicate stories are detected the same way as before', () => {
  const a = { category: 'sports', title: 'India beat Australia by six wickets in Delhi' };
  const b = { category: 'sports', title: 'India beat Australia by six wickets' };
  const c = { category: 'sports', title: 'Rain delays the start of play' };
  const crossGenre = { category: 'world', title: 'India beat Australia by six wickets' };

  assert.equal(curation.areSimilarNewsStories(a, b), true);
  assert.equal(curation.areSimilarNewsStories(a, c), false);
  assert.equal(curation.areSimilarNewsStories(a, crossGenre), false, 'similarity never crosses categories');

  if (legacy) {
    for (const [x, y] of [[a, b], [a, c], [a, crossGenre]]) {
      assert.equal(curation.areSimilarNewsStories(x, y), legacy.areSimilarNewsStories(x, y));
    }
  }
});

test('canonicalArticleUrl strips tracking so the same story is stored once', () => {
  assert.equal(
    curation.canonicalArticleUrl('https://x.example/a?utm_source=rss&at_medium=RSS&id=7#frag'),
    'https://x.example/a?id=7',
  );
  assert.equal(curation.canonicalArticleUrl('not a url'), '');
});

test('category balancing spreads the feed instead of letting one genre lead', () => {
  const now = Date.now();
  const articles = [];
  for (let i = 0; i < 6; i += 1) articles.push({ category: 'sports', title: `Sport story ${i}`, publishedAt: new Date(now - i * 1000) });
  for (let i = 0; i < 6; i += 1) articles.push({ category: 'science', title: `Science story ${i}`, publishedAt: new Date(now - i * 1000) });

  const balanced = curation.balanceNewsCategories(articles, 4);
  assert.equal(balanced.length, 4);
  assert.equal(new Set(balanced.map(a => a.category)).size, 2, 'both categories appear in the first four');

  if (legacy) {
    assert.deepEqual(
      curation.balanceNewsCategories(articles, 6).map(a => a.title),
      legacy.balanceNewsCategories(articles, 6).map(a => a.title),
    );
  }
});

test('selectStudentNews drops stale and future-dated candidates', () => {
  const now = new Date('2026-08-12T00:00:00Z');
  const fresh = { category: 'education', title: 'School opens a new library', summary: 'Students helped design it.', url: 'https://x.example/1', publishedAt: new Date('2026-08-11T00:00:00Z') };
  const stale = { category: 'education', title: 'An old assembly was held', summary: 'Long ago.', url: 'https://x.example/2', publishedAt: new Date('2026-01-01T00:00:00Z') };
  const future = { category: 'education', title: 'A future prize giving', summary: 'Next year.', url: 'https://x.example/3', publishedAt: new Date('2030-01-01T00:00:00Z') };

  const selected = curation.selectStudentNews([fresh, stale, future], { now, limit: 10 });
  assert.deepEqual(selected.map(a => a.url), ['https://x.example/1']);
});

test('the RSS parser still reads a real-shaped item', () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[School opens a new library]]></title>
    <description>&lt;p&gt;Students helped &amp; design it.&lt;/p&gt;</description>
    <link>https://x.example/library</link>
    <pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate>
    <media:thumbnail url="https://x.example/img.jpg"/>
  </item></channel></rss>`;
  const [item] = parseRssFeed(xml, { key: 'k', name: 'Example', category: 'education' });

  assert.equal(item.title, 'School opens a new library');
  assert.equal(item.summary, 'Students helped & design it.');
  assert.equal(item.url, 'https://x.example/library');
  assert.equal(item.imageUrl, 'https://x.example/img.jpg');
  assert.ok(item.publishedAt instanceof Date);

  if (legacy) {
    assert.deepEqual(item, legacy.parseRssFeed(xml, { key: 'k', name: 'Example', category: 'education' })[0]);
  }
});

test('a BBC ichef thumbnail is upsized to a card-quality rendition', () => {
  // Every live feed is a BBC one (search/rss.js's DEFAULT_NEWS_FEEDS), and BBC's
  // <media:thumbnail> always points at the 240px rendition sized for an old
  // RSS-reader thumbnail — stretched to fill a card's cover image, that reads
  // as blurry on a retina display. ichef encodes the requested width as a URL
  // path segment, so requesting a bigger step of the same crop is a same-domain,
  // same-asset substitution, not a new fetch target.
  const xml = `<rss><channel><item>
    <title><![CDATA[Regulator publishes new drone flight rules]]></title>
    <description>New rules for small aircraft.</description>
    <link>https://x.example/drones</link>
    <pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate>
    <media:thumbnail url="https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/865d/live/9d0547e0.jpg"/>
  </item></channel></rss>`;
  const [item] = parseRssFeed(xml, { key: 'bbc-top', name: 'BBC News', category: 'top' });
  assert.equal(item.imageUrl, 'https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/865d/live/9d0547e0.jpg');

  // Deliberately NOT compared against `legacy` here: services/ai/student-news.js
  // is a deprecated shim no UI calls any more (see CLAUDE.md), and does not get
  // this upsize — the two are meant to diverge on this one behavior.
});

test('decodeXml decoding is order-dependent, and safe only because the client escapes', () => {
  // Inherited behaviour, pinned deliberately rather than "fixed", because
  // changing it would break the port equivalence asserted above.
  //
  // The replacements are chained on one string, so the result depends on where
  // an entity sits in the chain. `&amp;` is replaced FIRST, and a /g replace
  // does not rescan its own output, so `&amp;amp;` decodes exactly one level.
  // `&lt;` is replaced LATER, operating on the already-rewritten string, so
  // `&amp;lt;` decodes twice and yields a real '<'.
  //
  // That is safe here only because every article field reaches the DOM through
  // escapeHtml()/safeUrl() in frontend/index.html — recovered markup renders as
  // visible text, never as a tag. If any future surface renders an article
  // field with innerHTML directly, this becomes an XSS vector and decodeXml
  // must be rewritten as a single pass over one alternation.
  assert.equal(curation.decodeXml('a &amp;amp; b'), 'a &amp; b', 'ampersand decodes one level');
  assert.equal(curation.decodeXml('&amp;lt;script&amp;gt;'), '<script>', 'angle brackets decode twice');
  if (legacy) {
    // Not exported by the predecessor; compare through the parser instead.
    const xml = '<item><title>a &amp;amp; b</title><link>https://x.example/1</link><pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate></item>';
    const feed = { key: 'k', name: 'Example', category: 'education' };
    assert.equal(parseRssFeed(xml, feed)[0].title, legacy.parseRssFeed(xml, feed)[0].title);
  }
});

test('an item missing a title, link or date is discarded rather than half-stored', () => {
  const xml = '<item><title>No link here</title><pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate></item>';
  assert.deepEqual(parseRssFeed(xml, { key: 'k', name: 'Example', category: 'education' }), []);
});
