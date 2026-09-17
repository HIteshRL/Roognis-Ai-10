'use strict';
// The hunt: pick the interests worth searching, search for them, curate what
// comes back, store it.
//
// Two design decisions carry the whole thing:
//
// 1. Hunting is PER TOPIC, not per student. One search for "drones" serves
//    every student who holds that node. Per-student hunting would multiply the
//    search bill by the roll and return near-identical articles each time.
//
// 2. Work is claimed from a HuntRun row, not run straight off a timer. The
//    predecessor refreshed news from an in-process setInterval, so at
//    replicas: 2 both pods hit the feeds and raced the same upserts. Here the
//    timer only *enqueues*; a worker claims a row with the same
//    updateMany({where:{id, status:'queued'}}) pattern quiz/practice/visuals
//    already use, so exactly one pod runs a given hunt.

const {
  selectStudentNews, isStudentSafeNews, areSimilarNewsStories,
  canonicalArticleUrl, cleanText,
} = require('../news/curation');
const { extractTopics, extractEntities, DEFAULT_VOCAB } = require('../interest/graph');
const { validateGeneratedTextSafety } = require('../safety');
const { buildHuntQueries } = require('./queries');
const { applyToneRewrite } = require('./tone');
const { fetchRssCandidates, DEFAULT_NEWS_FEEDS } = require('../search/rss');

const HUNT_CATEGORY = 'interests';
const ARTICLE_TTL_MS = 10 * 24 * 60 * 60 * 1000;
const RSS_SELECTION_LIMIT = 220;
const HUNT_SELECTION_LIMIT = 12;

// ── topic selection (deterministic, no model) ────────────────────────────────
/**
 * The topics most worth a search right now: highest total interest weight
 * across all students, excluding anything hunted inside the cooldown.
 *
 * groupBy over interest_nodes is the whole ranking. It is deliberately blunt —
 * a popularity sum — because "which topics do we spend search credits on" is a
 * cost decision, not a teaching one.
 */
async function selectHuntTopics(prisma, { limit = 12, now = new Date(), cooldownMs = 6 * 60 * 60 * 1000, vocab = DEFAULT_VOCAB } = {}) {
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
  const recent = await prisma.huntRun.findMany({
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

async function enqueueHuntRuns(prisma, topics = []) {
  if (!topics.length) return [];
  const created = [];
  for (const topic of topics) {
    created.push(await prisma.huntRun.create({
      data: { topicKey: topic.topicKey, topicLabel: topic.topicLabel, status: 'queued' },
    }));
  }
  return created;
}

/**
 * Take ownership of one queued run. Returns null if another pod got there
 * first — that is the normal, uninteresting outcome, not an error.
 */
async function claimHuntRun(prisma, { now = new Date() } = {}) {
  const candidate = await prisma.huntRun.findFirst({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  if (!candidate) return null;

  const claimed = await prisma.huntRun.updateMany({
    where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', startedAt: now },
  });
  if (!claimed.count) return null;
  return prisma.huntRun.findUnique({ where: { id: candidate.id } });
}

// ── turning search results into storable articles ────────────────────────────
/**
 * A search result is untrusted third-party text. It becomes a candidate article
 * only after: a parseable URL and title (already enforced by the provider
 * normaliser), the shared blocklist/genre gate, and the generated-text safety
 * rules. Anything that fails is dropped silently — a hunt returning fewer
 * articles is fine; a hunt returning one bad one is not.
 */
function searchResultToCandidate(result, { topicKey, topicLabel, now = new Date() }) {
  const title = cleanText(result?.title, 220);
  const summary = cleanText(result?.snippet || result?.content, 420);
  if (!title || !result?.url) return null;

  const candidate = {
    sourceKey: `hunt:${topicKey}`,
    sourceName: cleanText(result.sourceName, 120) || 'Web',
    category: HUNT_CATEGORY,
    title,
    summary: summary || title,
    url: result.url,
    imageUrl: result.imageUrl || null,
    // A search restricted to the last N days that omits a date is still recent;
    // treating it as `now` keeps it rankable. It is never presented as a
    // publication date the student can rely on beyond "recent".
    publishedAt: result.publishedAt instanceof Date ? result.publishedAt : now,
    huntTopicKey: topicKey,
    huntTopicLabel: topicLabel,
  };

  if (candidate.publishedAt > now) candidate.publishedAt = now;
  if (!isStudentSafeNews(candidate)) return null;

  const safety = validateGeneratedTextSafety(`${candidate.title}. ${candidate.summary}`);
  if (!safety.allowed) return null;

  return candidate;
}

async function storeArticles(prisma, articles, { now = new Date(), origin = 'rss', vocab = DEFAULT_VOCAB } = {}) {
  const expiresAt = new Date(now.getTime() + ARTICLE_TTL_MS);
  let stored = 0;
  for (const article of articles) {
    // Extract facets once, here. Ranking runs on every feed request and must
    // never re-parse article text.
    const topics = extractTopics(article, vocab).map(topic => topic.key);
    const entities = extractEntities(article).map(entity => entity.key);
    // A hunted article is about its topic by construction, even when the
    // keyword matchers miss the phrasing — otherwise the very interest that
    // paid for the search would not rank the result it bought.
    if (article.huntTopicKey && !topics.includes(article.huntTopicKey)) {
      topics.unshift(article.huntTopicKey);
    }

    const payload = {
      sourceKey: article.sourceKey,
      sourceName: article.sourceName,
      category: article.category,
      title: article.title,
      summary: article.summary,
      imageUrl: article.imageUrl || null,
      publishedAt: article.publishedAt,
      topics,
      entities,
      origin,
      huntTopicKey: article.huntTopicKey || null,
      safetyStatus: 'approved',
      expiresAt,
      // RSS candidates never set these — a permanently-null rawTitle/
      // rawSummary is what records that an article was never touched by the
      // tone-rewrite pass (hunt-only), not a missing backfill.
      rawTitle: article.rawTitle || null,
      rawSummary: article.rawSummary || null,
      toneRewritten: Boolean(article.toneRewritten),
      toneModel: article.toneModel || null,
      toneProvider: article.toneProvider || null,
    };

    await prisma.discoverArticle.upsert({
      where: { url: article.url },
      create: { url: article.url, ...payload },
      update: payload,
    });
    stored += 1;
  }
  return stored;
}

// ── the two producers ────────────────────────────────────────────────────────
/**
 * Execute one claimed hunt run. Always settles the row: a hunt that fails must
 * leave a 'failed' row with a reason, never a 'running' one that blocks the
 * topic's cooldown forever.
 */
async function executeHuntRun(prisma, run, { provider, now = new Date(), vocab = DEFAULT_VOCAB, logger = console, maxResults = 8 } = {}) {
  if (!provider) {
    await prisma.huntRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: 'No search provider configured.', finishedAt: new Date() },
    });
    return { stored: 0, found: 0, error: 'no_provider' };
  }

  try {
    const recent = await prisma.discoverArticle.findMany({
      where: { huntTopicKey: run.topicKey },
      orderBy: { publishedAt: 'desc' },
      take: 12,
      select: { title: true },
    });

    const { queries, source } = await buildHuntQueries({
      topicLabel: run.topicLabel || run.topicKey,
      avoidTitles: recent.map(r => r.title),
      now,
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

    // Every query failing is a real failure (bad key, no credit, provider
    // down). Some failing is not — partial results are still a good hunt.
    if (!results.length && failures.length) throw new Error(failures[0]);

    const seen = new Set();
    const kept = [];
    for (const result of results) {
      const candidate = searchResultToCandidate(result, {
        topicKey: run.topicKey, topicLabel: run.topicLabel, now,
      });
      if (!candidate) continue;
      const key = canonicalArticleUrl(candidate.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (kept.some(existing => areSimilarNewsStories(existing, candidate))) continue;
      kept.push(candidate);
      if (kept.length >= HUNT_SELECTION_LIMIT) break;
    }

    // Gen-Z tone rewrite — hunted articles only. RSS never calls this;
    // refreshRssArticles() has no reference to applyToneRewrite anywhere.
    const toned = await applyToneRewrite(prisma, kept, { logger });

    const stored = await storeArticles(prisma, toned, { now, origin: 'hunt', vocab });
    await prisma.huntRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        queries,
        provider: `${provider.name}${source === 'fallback' ? '+templates' : ''}`,
        resultCount: results.length,
        storedCount: stored,
        error: failures.length ? failures.join(' | ').slice(0, 1000) : null,
        finishedAt: new Date(),
      },
    });
    return { stored, found: results.length, queries };
  } catch (err) {
    await prisma.huntRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: String(err.message || err).slice(0, 1000), finishedAt: new Date() },
    });
    logger.warn?.(`[discover] hunt failed for "${run.topicKey}": ${err.message}`);
    return { stored: 0, found: 0, error: err.message };
  }
}

/** The keyless floor: refresh the curated RSS genres. */
async function refreshRssArticles(prisma, { fetchImpl = fetch, feeds = DEFAULT_NEWS_FEEDS, now = new Date(), vocab = DEFAULT_VOCAB, selectionLimit = RSS_SELECTION_LIMIT } = {}) {
  const { candidates, errors, successfulFeedKeys } = await fetchRssCandidates({ feeds, fetchImpl });
  const selected = selectStudentNews(candidates, { now, limit: selectionLimit });
  const stored = await storeArticles(prisma, selected, { now, origin: 'rss', vocab });

  // Reconcile only the categories whose feed actually answered, so a 503 from
  // one publisher cannot delete that publisher's existing articles.
  if (successfulFeedKeys.length) {
    await prisma.discoverArticle.deleteMany({
      where: {
        sourceKey: { in: successfulFeedKeys },
        ...(selected.length ? { url: { notIn: selected.map(article => article.url) } } : {}),
      },
    });
  }
  await prisma.discoverArticle.deleteMany({ where: { expiresAt: { lt: now } } });

  return { fetched: candidates.length, approved: selected.length, stored, errors };
}

module.exports = {
  HUNT_CATEGORY, ARTICLE_TTL_MS, HUNT_SELECTION_LIMIT,
  selectHuntTopics, enqueueHuntRuns, claimHuntRun,
  searchResultToCandidate, storeArticles, executeHuntRun, refreshRssArticles,
};
