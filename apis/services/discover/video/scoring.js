'use strict';
// Deterministic video ranking — the reason this feature exists.
//
// YouTube's own search relevance order optimizes for watch-time-at-scale,
// which structurally favours large mainstream channels. Per MASTERCONTEXT §7,
// no LLM may sit in a ranking/scoring path, so the fix is a plain formula over
// inspectable signals, computed once per candidate at hunt time — never at
// feed-request time, and never by a model.
//
// Deliberately excluded: subscriber count is not a positive scoring input. A
// size-based credibility bonus, even capped, would quietly re-introduce the
// exact mainstream-over-niche bias this file exists to remove. There is also
// no hand-maintained "mainstream" denylist — a newsroom's uploads necessarily
// span many topic clusters, so topicNarrowness (see hunt/video-run.js) comes
// out low for them on its own.

const { recencyScore } = require('../interest/graph');

// Below this, a "match" is coincidental (a stray shared word), not aboutness.
// Dropped entirely, not merely down-ranked — mirrors the topic-match floor
// services/ai/video-search.js's scoreVideoRelevance already uses for the same
// reason: a topic-match floor gates entry into ranking at all.
const MIN_TOPIC_RELEVANCE = 0.3;

const NICHE_BOOST = Object.freeze({
  trusted: 40,
  pending: 25,   // scaled by topicNarrowness — see scoreVideoCandidate
  unknown: 0,
});

/**
 * `topicScore` is extractTopics()'s raw integer match count for the hunt's own
 * topic key (0, 1, 2, ...) — not yet normalised. Two independent regex matches
 * already earns full credit, same generosity as the rest of this pipeline's
 * topic matching.
 */
function topicRelevanceFor(topicScore) {
  return Math.min(1, Math.max(0, Number(topicScore) || 0) / 2);
}

function nicheBoostFor(channelTrustStatus, channelNarrowness) {
  if (channelTrustStatus === 'trusted') return NICHE_BOOST.trusted;
  if (channelTrustStatus === 'pending') return NICHE_BOOST.pending * Math.max(0, Math.min(1, Number(channelNarrowness) || 0));
  return NICHE_BOOST.unknown;
}

function durationFitFor(durationSeconds) {
  const seconds = Number(durationSeconds) || 0;
  if (seconds < 90) return -8;              // likely a Short/clip, not analysis
  if (seconds > 3600) return -4;            // multi-hour stream, weak signal either way
  if (seconds >= 300 && seconds <= 2400) return 6;  // 5-40 min: the long-form sweet spot
  return 0;
}

/**
 * Score one video candidate. `channel` is the (possibly seeded, possibly
 * `null` if never enriched) TrustedChannel row for this video's channel —
 * `null`/absent is treated as 'unknown', not 'blocked'; a 'blocked' channel
 * must be excluded by the caller before this is ever invoked.
 *
 * Returns null when the candidate fails the topic-relevance floor — a signal
 * to drop it, not merely rank it low.
 */
function scoreVideoCandidate({ topicScore, channel, publishedAt, durationSeconds, now = new Date() } = {}) {
  const topicRelevance = topicRelevanceFor(topicScore);
  if (topicRelevance < MIN_TOPIC_RELEVANCE) return null;

  const channelTrustStatus = channel?.status || 'unknown';
  const nicheBoost = nicheBoostFor(channelTrustStatus, channel?.topicNarrowness);
  const recencyTerm = 10 * recencyScore(publishedAt, now);
  const durationFit = durationFitFor(durationSeconds);
  const score = 55 * topicRelevance + nicheBoost + recencyTerm + durationFit;

  return { score, topicRelevance, nicheBoost, recencyTerm, durationFit, channelTrustStatus };
}

module.exports = { MIN_TOPIC_RELEVANCE, NICHE_BOOST, topicRelevanceFor, nicheBoostFor, durationFitFor, scoreVideoCandidate };
