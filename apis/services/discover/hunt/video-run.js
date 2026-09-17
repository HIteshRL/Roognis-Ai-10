'use strict';
// The video hunt: pick the interests worth searching, search YouTube, score
// for niche-over-mainstream, store it. Mirrors hunt/run.js's article pipeline
// structurally (per-topic not per-student, enqueue/claim split for
// multi-replica safety), with one new stage — channel enrichment — and one
// deliberate divergence — candidates are sorted by score BEFORE capping to
// the selection limit, not capped in encounter order. Capping in encounter
// order would just re-store YouTube's own relevance order under a different
// name, defeating the entire feature.
//
// selectVideoHuntTopics below is a ~15-line copy of hunt/run.js's
// selectHuntTopics against VideoHuntRun instead of HuntRun, rather than a
// parameterized shared function — a deliberate choice to leave the article
// hunt's shared, tested code untouched.

const { isStudentSafeNews, cleanText } = require('../news/curation');
const { extractTopics, extractEntities, DEFAULT_VOCAB } = require('../interest/graph');
const { validateGeneratedTextSafety } = require('../safety');
const { buildVideoHuntQueries } = require('./video-queries');
const { scoreVideoCandidate } = require('../video/scoring');
const { ensureChannelEnriched, ENRICHMENT_FRESHNESS_MS } = require('../video/trust');

// Must match news/curation.js's HUNT_GENRES set — 'interests' is the one
// category that bypasses the "prove constructive framing" gate (a query the
// student's own interest graph asked for isn't held to the same bar as an
// untargeted world-news feed) while still passing the blocklist.
const VIDEO_HUNT_CATEGORY = 'interests';
const VIDEO_TTL_MS = 10 * 24 * 60 * 60 * 1000; // parity with articles — see HANDOFF risk note
const VIDEO_HUNT_SELECTION_LIMIT = 12;
const DEFAULT_MAX_CHANNEL_ENRICH_PER_RUN = 5;

// ── topic selection (deterministic, no model) ────────────────────────────────
async function selectVideoHuntTopics(prisma, { limit = 3, now = new Date(), cooldownMs = 24 * 60 * 60 * 1000, vocab = DEFAULT_VOCAB } = {}) {
  const grouped = await prisma.interestNode.groupBy({
    by: ['key'],
    where: { kind: 'topic', weight: { gt: 0 } },
    _sum: { weight: true },
    _count: { _all: true },
    orderBy: { _sum: { weight: 'desc' } },
    take: Math.max(1, limit * 3),
  });
  if (!grouped.length) return [];

  const since = new Date(now.getTime() - cooldownMs);
  const recent = await prisma.videoHuntRun.findMany({
    where: { createdAt: { gte: since }, status: { in: ['queued', 'running', 'done'] } },
    select: { topicKey: true },
    distinct: ['topicKey'],
  });
  const cooling = new Set(recent.map(r => r.topicKey));

  return grouped
    .filter(row => !cooling.has(row.key))
    .slice(0, limit)
    .map(row => ({
      topicKey: row.key,
      topicLabel: vocab.labelOf(row.key),
      totalWeight: Number((row._sum.weight || 0).toFixed(3)),
      studentCount: row._count._all,
    }));
}

async function enqueueVideoHuntRuns(prisma, topics = []) {
  if (!topics.length) return [];
  const created = [];
  for (const topic of topics) {
    created.push(await prisma.videoHuntRun.create({
      data: { topicKey: topic.topicKey, topicLabel: topic.topicLabel, status: 'queued' },
    }));
  }
  return created;
}

async function claimVideoHuntRun(prisma, { now = new Date() } = {}) {
  const candidate = await prisma.videoHuntRun.findFirst({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  if (!candidate) return null;

  const claimed = await prisma.videoHuntRun.updateMany({
    where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', startedAt: now },
  });
  if (!claimed.count) return null;
  return prisma.videoHuntRun.findUnique({ where: { id: candidate.id } });
}

// ── turning search results into storable candidates ──────────────────────────
function searchResultToVideoCandidate(result, { topicKey, topicLabel, now = new Date() }) {
  const title = cleanText(result?.title, 240);
  const summary = cleanText(result?.snippet, 2000);
  if (!title || !result?.url || !result?.videoId || !result?.channelId) return null;

  const candidate = {
    videoId: result.videoId,
    channelId: result.channelId,
    channelName: cleanText(result.channelName, 160) || 'YouTube',
    category: VIDEO_HUNT_CATEGORY,
    title,
    summary: summary || title,
    url: result.url,
    thumbnailUrl: result.imageUrl || null,
    publishedAt: result.publishedAt instanceof Date && !Number.isNaN(result.publishedAt.getTime()) ? result.publishedAt : now,
    huntTopicKey: topicKey,
    huntTopicLabel: topicLabel,
  };

  if (candidate.publishedAt > now) candidate.publishedAt = now;
  if (!isStudentSafeNews(candidate)) return null;

  const textSafety = validateGeneratedTextSafety(`${candidate.title}. ${candidate.summary}`);
  if (!textSafety.allowed) return null;
  const channelSafety = validateGeneratedTextSafety(candidate.channelName);
  if (!channelSafety.allowed) return null;

  return candidate;
}

async function storeVideos(prisma, videos, { now = new Date(), vocab = DEFAULT_VOCAB } = {}) {
  const expiresAt = new Date(now.getTime() + VIDEO_TTL_MS);
  let stored = 0;
  for (const video of videos) {
    const topics = extractTopics(video, vocab).map(topic => topic.key);
    const entities = extractEntities(video).map(entity => entity.key);
    if (video.huntTopicKey && !topics.includes(video.huntTopicKey)) topics.unshift(video.huntTopicKey);

    const payload = {
      channelId: video.channelId,
      channelName: video.channelName,
      category: video.category,
      title: video.title,
      summary: video.summary,
      thumbnailUrl: video.thumbnailUrl || null,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds || 0,
      viewCount: video.viewCount || 0,
      topics,
      entities,
      origin: 'hunt',
      huntTopicKey: video.huntTopicKey || null,
      safetyStatus: 'approved',
      expiresAt,
      channelTrustStatus: video.channelTrustStatus || 'pending',
      channelNarrowness: video.channelNarrowness ?? null,
      nicheScore: video.nicheScore || 0,
    };

    await prisma.discoverVideo.upsert({
      where: { videoId: video.videoId },
      create: { videoId: video.videoId, url: video.url, ...payload },
      update: payload,
    });
    stored += 1;
  }
  return stored;
}

// ── the producer ─────────────────────────────────────────────────────────────
async function executeVideoHuntRun(prisma, run, {
  provider, now = new Date(), vocab = DEFAULT_VOCAB, logger = console,
  maxResults = 8, maxChannelEnrichPerRun = DEFAULT_MAX_CHANNEL_ENRICH_PER_RUN,
} = {}) {
  if (!provider) {
    await prisma.videoHuntRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: 'No search provider configured.', finishedAt: new Date() },
    });
    return { stored: 0, found: 0, error: 'no_provider' };
  }

  try {
    const recent = await prisma.discoverVideo.findMany({
      where: { huntTopicKey: run.topicKey },
      orderBy: { publishedAt: 'desc' },
      take: 12,
      select: { title: true },
    });

    const { queries, source } = await buildVideoHuntQueries({
      topicLabel: run.topicLabel || run.topicKey,
      avoidTitles: recent.map(r => r.title),
      logger,
    });
    if (!queries.length) throw new Error('No usable search queries for this topic.');

    const settled = await Promise.allSettled(
      queries.map(query => provider.search({ query, maxResults })),
    );
    const results = [];
    const failures = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') results.push(...outcome.value);
      else failures.push(`${queries[index]}: ${outcome.reason?.message || 'search failed'}`);
    });
    if (!results.length && failures.length) throw new Error(failures[0]);

    // Dedupe by videoId — a stable key, unlike article URLs, so no
    // areSimilarNewsStories-equivalent similarity check is needed.
    const seen = new Set();
    const candidates = [];
    for (const result of results) {
      const candidate = searchResultToVideoCandidate(result, { topicKey: run.topicKey, topicLabel: run.topicLabel, now });
      if (!candidate || seen.has(candidate.videoId)) continue;
      seen.add(candidate.videoId);
      candidates.push(candidate);
    }

    // Cheap, batched detail enrichment (duration/view count) for every
    // survivor — also drops anything YouTube reports as non-embeddable.
    const detailByVideoId = await provider.loadVideoDetails(candidates.map(c => c.videoId));
    const withDetails = [];
    for (const candidate of candidates) {
      const details = detailByVideoId.get(candidate.videoId);
      if (!details) continue;
      withDetails.push({ ...candidate, durationSeconds: details.durationSeconds, viewCount: details.viewCount });
    }

    // Channel enrichment — the quota-heaviest step, bounded per run. A
    // channel already fresh (recently enriched, or seeded-trusted) costs
    // nothing here; a budget-exhausted channel is treated as unknown, never
    // excluded — enrichment is a bonus, never a storage gate.
    const distinctChannelIds = [...new Set(withDetails.map(c => c.channelId))];
    const channelByChannelId = new Map();
    let channelsEnriched = 0;
    for (const channelId of distinctChannelIds) {
      const existing = await prisma.trustedChannel.findUnique({ where: { channelId } });
      const isFresh = existing?.status === 'blocked'
        || existing?.seedSource === 'curated'
        || (existing?.lastEnrichedAt && now.getTime() - existing.lastEnrichedAt.getTime() < ENRICHMENT_FRESHNESS_MS);
      if (isFresh) {
        channelByChannelId.set(channelId, existing);
        continue;
      }
      if (channelsEnriched >= maxChannelEnrichPerRun) {
        channelByChannelId.set(channelId, existing || null);
        continue;
      }
      const channelName = withDetails.find(c => c.channelId === channelId)?.channelName;
      const enriched = await ensureChannelEnriched(prisma, provider, { channelId, channelName, now, vocab, logger });
      channelByChannelId.set(channelId, enriched);
      channelsEnriched += 1;
    }

    // Hard-exclude blocked channels before scoring — a pre-filter, not a
    // score penalty.
    const notBlocked = withDetails.filter(c => channelByChannelId.get(c.channelId)?.status !== 'blocked');

    // Score every survivor, then sort by score BEFORE capping (see this
    // file's header and video/scoring.js).
    const scored = [];
    for (const candidate of notBlocked) {
      const topicMatches = extractTopics({ title: candidate.title, summary: candidate.summary }, vocab);
      const topicScore = topicMatches.find(t => t.key === candidate.huntTopicKey)?.score ?? 0;
      const channel = channelByChannelId.get(candidate.channelId);
      const result = scoreVideoCandidate({
        topicScore, channel, publishedAt: candidate.publishedAt, durationSeconds: candidate.durationSeconds, now,
      });
      if (!result) continue; // below the topic-relevance floor
      scored.push({
        ...candidate,
        channelTrustStatus: result.channelTrustStatus,
        channelNarrowness: channel?.topicNarrowness ?? null,
        nicheScore: result.score,
      });
    }
    scored.sort((a, b) => b.nicheScore - a.nicheScore);
    const kept = scored.slice(0, VIDEO_HUNT_SELECTION_LIMIT);

    const stored = await storeVideos(prisma, kept, { now, vocab });
    await prisma.videoHuntRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        queries,
        provider: `${provider.name}${source === 'fallback' ? '+templates' : ''}`,
        resultCount: results.length,
        storedCount: stored,
        channelsEnriched,
        error: failures.length ? failures.join(' | ').slice(0, 1000) : null,
        finishedAt: new Date(),
      },
    });
    return { stored, found: results.length, queries };
  } catch (err) {
    await prisma.videoHuntRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: String(err.message || err).slice(0, 1000), finishedAt: new Date() },
    });
    logger.warn?.(`[discover] video hunt failed for "${run.topicKey}": ${err.message}`);
    return { stored: 0, found: 0, error: err.message };
  }
}

module.exports = {
  VIDEO_HUNT_CATEGORY, VIDEO_TTL_MS, VIDEO_HUNT_SELECTION_LIMIT, DEFAULT_MAX_CHANNEL_ENRICH_PER_RUN,
  selectVideoHuntTopics, enqueueVideoHuntRuns, claimVideoHuntRun,
  searchResultToVideoCandidate, storeVideos, executeVideoHuntRun,
};
