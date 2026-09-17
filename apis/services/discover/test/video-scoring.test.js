'use strict';
// Deterministic video ranking — the literal "niche analyst beats mainstream
// newsroom" scenario as a regression guard, plus the topic-relevance floor
// and the deliberate exclusion of subscriber count from the formula.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_TOPIC_RELEVANCE, scoreVideoCandidate, topicRelevanceFor, nicheBoostFor, durationFitFor,
} = require('../video/scoring');

const NOW = new Date('2026-08-22T12:00:00Z');
const RECENT = new Date('2026-08-22T09:00:00Z'); // 3h old

test('a trusted, narrow niche channel outranks an unknown, broad-uploads channel on an identical topic/recency/duration profile', () => {
  const shared = { topicScore: 2, publishedAt: RECENT, durationSeconds: 900, now: NOW };

  const niche = scoreVideoCandidate({ ...shared, channel: { status: 'trusted', topicNarrowness: 0.95 } });
  const mainstream = scoreVideoCandidate({ ...shared, channel: null }); // never enriched -> unknown

  assert.ok(niche, 'trusted candidate must clear the relevance floor');
  assert.ok(mainstream, 'unknown candidate must clear the relevance floor too — this test isolates the niche signal, not relevance');
  assert.ok(niche.score > mainstream.score, `trusted niche channel (${niche.score}) must outscore an unknown channel (${mainstream.score}) with identical topic/recency/duration`);
});

test('a pending channel is scaled by its measured topicNarrowness, not treated as fully trusted', () => {
  const shared = { topicScore: 2, publishedAt: RECENT, durationSeconds: 900, now: NOW };
  const narrow = scoreVideoCandidate({ ...shared, channel: { status: 'pending', topicNarrowness: 0.9 } });
  const broad = scoreVideoCandidate({ ...shared, channel: { status: 'pending', topicNarrowness: 0.1 } });
  const trusted = scoreVideoCandidate({ ...shared, channel: { status: 'trusted' } });

  assert.ok(narrow.score > broad.score, 'a narrower channel must score higher than a broad-uploads one at the same trust status');
  assert.ok(trusted.score > narrow.score, 'a seeded/promoted trusted channel outranks even a highly narrow pending one');
});

test('a candidate below the topic-relevance floor is dropped, not merely down-ranked', () => {
  const result = scoreVideoCandidate({
    topicScore: 0, channel: { status: 'trusted' }, publishedAt: RECENT, durationSeconds: 900, now: NOW,
  });
  assert.equal(result, null, 'a zero topic-match score must never survive scoring regardless of channel trust');

  assert.ok(topicRelevanceFor(0) < MIN_TOPIC_RELEVANCE, 'no regex match at all for the hunt topic must not clear the floor');
  assert.equal(topicRelevanceFor(0), 0);
});

test('a blocked channel is the caller\'s responsibility to exclude before scoring, not this function\'s', () => {
  // scoreVideoCandidate itself does not special-case 'blocked' — hunt/video-run.js
  // pre-filters blocked channels before this is ever called. Verify a 'blocked'
  // status here just falls through nicheBoostFor's unknown branch (0 boost),
  // documenting that this function alone is not the safety boundary.
  assert.equal(nicheBoostFor('blocked', 0.9), 0);
});

test('subscriber count has zero effect on score — a regression guard against reintroducing size bias', () => {
  const base = { topicScore: 2, channel: { status: 'pending', topicNarrowness: 0.5, subscriberCount: 200 }, publishedAt: RECENT, durationSeconds: 900, now: NOW };
  const withHugeSubscribers = { ...base, channel: { ...base.channel, subscriberCount: 50_000_000 } };

  assert.equal(scoreVideoCandidate(base).score, scoreVideoCandidate(withHugeSubscribers).score,
    'subscriberCount must never be read by the scoring formula');
});

test('duration fit rewards the long-form sweet spot and penalises Shorts and multi-hour streams', () => {
  assert.equal(durationFitFor(30), -8, 'sub-90s is likely a Short/clip');
  assert.equal(durationFitFor(600), 6, '5-40 minutes is the long-form analysis sweet spot');
  assert.equal(durationFitFor(7200), -4, 'a 2-hour stream is a weak signal either way');
  assert.equal(durationFitFor(1200), 6);
});

test('recency still matters within the niche signal, same half-life as articles', () => {
  const shared = { topicScore: 2, channel: { status: 'unknown' }, durationSeconds: 900 };
  const fresh = scoreVideoCandidate({ ...shared, publishedAt: NOW, now: NOW });
  const old = scoreVideoCandidate({ ...shared, publishedAt: new Date('2026-08-01T00:00:00Z'), now: NOW });
  assert.ok(fresh.score > old.score);
});
