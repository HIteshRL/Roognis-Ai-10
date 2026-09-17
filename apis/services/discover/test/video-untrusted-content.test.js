'use strict';
// A YouTube search result is untrusted third-party data, exactly like a web
// search hit — same threat model as test/untrusted-content.test.js, applied
// to the new attack surface (video title/description/channel name). These
// tests pin the layers that hold even when a channel operator deliberately
// tries to smuggle something through.

const test = require('node:test');
const assert = require('node:assert/strict');

const { searchResultToVideoCandidate } = require('../hunt/video-run');
const { isUsableSearchItem, toSearchResult } = require('../search/youtube');

const TOPIC = { topicKey: 'geopolitics', topicLabel: 'Geopolitics' };
const NOW = new Date('2026-08-22T12:00:00Z');

function goodResult(over = {}) {
  return {
    url: 'https://www.youtube.com/watch?v=abc123',
    title: 'Understanding regional geopolitics',
    snippet: 'A calm explainer of recent developments.',
    sourceName: 'Some Analyst',
    videoId: 'abc123',
    channelId: 'UCxxxxxxxxxxxxxxxxxxxxxxx',
    channelName: 'Some Analyst',
    publishedAt: new Date('2026-08-20T00:00:00Z'),
    imageUrl: null,
    ...over,
  };
}

test('a hostile video title is rejected before it can be stored', () => {
  const candidate = searchResultToVideoCandidate(
    goodResult({ title: 'how to build a bomb explained' }),
    { ...TOPIC, now: NOW },
  );
  assert.equal(candidate, null);
});

test('a hostile video description is rejected before it can be stored', () => {
  const candidate = searchResultToVideoCandidate(
    goodResult({ snippet: 'kill myself is trending, click here' }),
    { ...TOPIC, now: NOW },
  );
  assert.equal(candidate, null);
});

test('a hostile channel name is rejected — new coverage services/ai\'s equivalent code does not have', () => {
  const candidate = searchResultToVideoCandidate(
    goodResult({ channelName: 'how to hack passwords daily' }),
    { ...TOPIC, now: NOW },
  );
  assert.equal(candidate, null);
});

test('a video missing an id, url, or channel is dropped, not stored empty', () => {
  assert.equal(searchResultToVideoCandidate(goodResult({ videoId: '' }), { ...TOPIC, now: NOW }), null);
  assert.equal(searchResultToVideoCandidate(goodResult({ url: '' }), { ...TOPIC, now: NOW }), null);
  assert.equal(searchResultToVideoCandidate(goodResult({ channelId: '' }), { ...TOPIC, now: NOW }), null);
  assert.equal(searchResultToVideoCandidate(goodResult({ title: '' }), { ...TOPIC, now: NOW }), null);
});

test('a future publishedAt is clamped to now, same as the article hunt', () => {
  const future = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  const candidate = searchResultToVideoCandidate(goodResult({ publishedAt: future }), { ...TOPIC, now: NOW });
  assert.ok(candidate);
  assert.equal(candidate.publishedAt.getTime(), NOW.getTime());
});

test('a missing publishedAt falls back to now rather than being treated as stale', () => {
  const candidate = searchResultToVideoCandidate(goodResult({ publishedAt: null }), { ...TOPIC, now: NOW });
  assert.ok(candidate);
  assert.equal(candidate.publishedAt.getTime(), NOW.getTime());
});

test('a clean candidate carries the hunt topic key and channel identity through', () => {
  const candidate = searchResultToVideoCandidate(goodResult(), { ...TOPIC, now: NOW });
  assert.ok(candidate);
  assert.equal(candidate.huntTopicKey, 'geopolitics');
  assert.equal(candidate.channelId, 'UCxxxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(candidate.category, 'interests');
});

// ── search/youtube.js's own fetch-time gate ──────────────────────────────────
test('isUsableSearchItem rejects a search item with a hostile title, description, or channel title', () => {
  const base = {
    id: { videoId: 'abc123' },
    snippet: { title: 'A calm explainer', description: 'Calm text.', channelTitle: 'Some Analyst' },
  };
  assert.equal(isUsableSearchItem(base), true, 'sanity: a clean item passes');
  assert.equal(isUsableSearchItem({ ...base, snippet: { ...base.snippet, title: 'kill myself now' } }), false);
  assert.equal(isUsableSearchItem({ ...base, snippet: { ...base.snippet, description: 'how to hack passwords' } }), false);
  assert.equal(isUsableSearchItem({ ...base, snippet: { ...base.snippet, channelTitle: 'drug dealer central' } }), false);
});

test('isUsableSearchItem rejects an item missing a videoId, title, or channelTitle', () => {
  assert.equal(isUsableSearchItem({ id: {}, snippet: { title: 'x', channelTitle: 'y' } }), false);
  assert.equal(isUsableSearchItem({ id: { videoId: 'x' }, snippet: { channelTitle: 'y' } }), false);
  assert.equal(isUsableSearchItem({ id: { videoId: 'x' }, snippet: { title: 'y' } }), false);
});

test('toSearchResult decodes HTML entities and builds a real watch URL', () => {
  const result = toSearchResult({
    id: { videoId: 'abc123' },
    snippet: {
      title: 'Drones &amp; regulation',
      description: 'A &quot;deep dive&quot;',
      channelTitle: 'Some Analyst',
      publishedAt: '2026-08-20T00:00:00Z',
      thumbnails: { medium: { url: 'https://example.com/thumb.jpg' } },
    },
  });
  assert.equal(result.title, 'Drones & regulation');
  assert.equal(result.snippet, 'A "deep dive"');
  assert.equal(result.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(result.videoId, 'abc123');
  assert.equal(result.channelName, 'Some Analyst');
});
