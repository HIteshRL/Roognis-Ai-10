require('./load-env');

const express = require('express');
const { createHash } = require('node:crypto');
const cookieParser = require('cookie-parser');
const prisma = require('./lib/prisma');
const requireAuth = require('./middleware/auth');
const requireInternalToken = require('./middleware/internal-token');

const { GENRES, GENRE_LABEL, SIGNAL_KINDS, rankArticles, explorationRateFor, DEFAULT_VOCAB } = require('./interest/graph');
const { applySignal, loadNodes, nodesToVector, rebuildProfile, loadGraph } = require('./interest/store');
const { candidateDecision, mergeEvidence, PROMOTION_EVIDENCE_THRESHOLD } = require('./interest/promote');
const { proposeInterests } = require('./interest/propose');
const { loadVocabulary, registerTopic, ensureTopicsLoaded } = require('./interest/registry');
const { ensureStudentBootstrapped } = require('./interest/bootstrap');
const { balanceNewsCategories } = require('./news/curation');
const { buildReadingStats } = require('./stats');
const { resolveSearchProvider } = require('./search/provider');
const {
  selectHuntTopics, enqueueHuntRuns, claimHuntRun, executeHuntRun, refreshRssArticles, HUNT_CATEGORY,
} = require('./hunt/run');
const { fetchWeakAreas, selectCardTarget } = require('./cards/prioritize');
const {
  fetchChapterContext, selectGroundingChunks, chapterKeyFor, buildProvenance,
} = require('./cards/grounding');
const { generateAcademicCard, generateMicroArticle } = require('./cards/generate');
const { collectAcademicCardText, collectMicroArticleText } = require('./cards/validate');
const { interleaveMicroArticles } = require('./cards/interleave');
const { validateGeneratedTextSafety } = require('./safety');
const { resolveVideoSearchProvider } = require('./search/youtube');
const {
  selectVideoHuntTopics, enqueueVideoHuntRuns, claimVideoHuntRun, executeVideoHuntRun,
} = require('./hunt/video-run');
const { seedTrustedChannels, recordChannelEvidence, MIN_QUALIFYING_DWELL_MS } = require('./video/trust');
const { interleaveVideos } = require('./video/interleave');
const { createPreferenceGraphqlHandler } = require('./preference/graphql');
const { observeTutorText, withPreferenceLock, blocked, setPreference, applyPreference } = require('./preference/service');
const { refreshPreferenceProfiles } = require('./preference/refresh');

const app = express();
const PORT = process.env.PORT || 3008;
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:3004';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai:3002';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const PREFERENCE_GNN_URL = process.env.PREFERENCE_GNN_URL || 'http://preference-gnn:3013';
const PREFERENCE_GNN_TRAINER_URL = process.env.PREFERENCE_GNN_TRAINER_URL || 'http://preference-gnn-trainer:3016';
const DECISION_SERVICE_URL = process.env.DECISION_SERVICE_URL || 'http://decisions:3014';
const PREFERENCE_REFRESH_ENABLED = process.env.PREFERENCE_REFRESH_ENABLED !== 'false';
const PREFERENCE_REFRESH_INTERVAL_MS = Math.max(3600000, Number(process.env.PREFERENCE_REFRESH_INTERVAL_MS) || 86400000);
const studentOnly = [requireAuth, requireAuth.requireRole('student')];
const backgroundTasks = new Set();

const HUNT_ENABLED = String(process.env.DISCOVER_HUNT_ENABLED || 'true').toLowerCase() === 'true';
// Floored at 15 minutes: this timer enqueues work that costs search credits and
// model calls, and a misconfigured interval should not be able to bankrupt it.
const HUNT_INTERVAL_MS = Math.max(
  Number(process.env.DISCOVER_HUNT_INTERVAL_MS) || 3 * 60 * 60 * 1000,
  15 * 60 * 1000,
);
const HUNT_MAX_TOPICS_PER_RUN = Math.max(1, Math.min(50, Number(process.env.DISCOVER_HUNT_MAX_TOPICS_PER_RUN) || 12));
const HUNT_TOPIC_COOLDOWN_MS = Math.max(
  Number(process.env.DISCOVER_HUNT_TOPIC_COOLDOWN_MS) || HUNT_INTERVAL_MS * 2,
  30 * 60 * 1000,
);
const RSS_ENABLED = String(process.env.DISCOVER_RSS_ENABLED || 'true').toLowerCase() === 'true';

// Video hunt runs far less often than the article hunt — search.list costs
// 100 quota units/call against a default 10,000-unit/day budget, so a
// per-tick topic cap of 12 (the article default) would exhaust it in one
// tick. See hunt/video-run.js and video/trust.js for the rest of the pipeline.
const VIDEO_HUNT_ENABLED = String(process.env.DISCOVER_VIDEO_HUNT_ENABLED || 'true').toLowerCase() === 'true';
const VIDEO_HUNT_INTERVAL_MS = Math.max(
  Number(process.env.DISCOVER_VIDEO_HUNT_INTERVAL_MS) || 24 * 60 * 60 * 1000,
  60 * 60 * 1000, // floored at 1h
);
const VIDEO_HUNT_MAX_TOPICS_PER_RUN = Math.max(1, Math.min(10, Number(process.env.DISCOVER_VIDEO_HUNT_MAX_TOPICS_PER_RUN) || 3));
const VIDEO_HUNT_TOPIC_COOLDOWN_MS = Math.max(
  Number(process.env.DISCOVER_VIDEO_HUNT_TOPIC_COOLDOWN_MS) || 24 * 60 * 60 * 1000,
  60 * 60 * 1000,
);
const VIDEO_HUNT_MAX_CHANNEL_ENRICH_PER_RUN = Math.max(1, Math.min(20, Number(process.env.DISCOVER_VIDEO_HUNT_MAX_CHANNEL_ENRICH_PER_RUN) || 5));
// A backstop beyond the per-tick topic cap, since search.list is the dominant
// cost. In-process, matching the article hunt's own current single-replica
// posture — needs a DB-backed claim if this service ever runs replicas > 1
// (see HANDOFF.md).
const VIDEO_HUNT_DAILY_SEARCH_BUDGET = Math.max(100, Number(process.env.DISCOVER_VIDEO_HUNT_DAILY_SEARCH_BUDGET) || 3000);
const VIDEO_SEARCH_UNIT_COST = 100;

// A video every 8th article, absolute-position-based (see
// video/interleave.js) — less frequent than the micro-article cards'
// every-4th, since a video is a heavier content commitment than a short card.
const FEED_VIDEO_POOL_SIZE = 60;
const VIDEO_FEED_EVERY_N = 8;
const VIDEO_FEED_QUEUE_SIZE = 8;

const FEED_POOL_SIZE = 260;
const MAX_FEED_LIMIT = 40;
const MAX_FEED_OFFSET = 400;
const MAX_DWELL_MS = 900000;

const MAX_CARD_LIMIT = 10;
const CARD_GROUNDING_CHUNK_LIMIT = 24;

// A micro-article every 4th article, absolute-position-based so a card lands
// at the same spot in the overall feed regardless of how the client paginates
// (see cards/interleave.js). QUEUE_FETCH is a generous upper bound on how many
// undelivered done cards a single feed response could ever consume.
const MICRO_ARTICLE_EVERY_N = 4;
const MICRO_ARTICLE_QUEUE_FETCH = 10;
const MICRO_ARTICLE_PREWARM_THRESHOLD = 2;

// Rebuilt at boot from interest_topics. `let` because the vocabulary grows at
// runtime — a promoted candidate adds to this object in place.
let vocab = DEFAULT_VOCAB;
let searchProvider = null;
let videoSearchProvider = null;
// In-process daily search.list quota counter, reset at UTC midnight. See the
// VIDEO_HUNT_DAILY_SEARCH_BUDGET comment above for the multi-replica caveat.
let videoSearchUnitsSpentToday = 0;
let videoSearchBudgetDay = null;

function resetVideoSearchBudgetIfNewDay(now) {
  const day = now.toISOString().slice(0, 10);
  if (videoSearchBudgetDay !== day) {
    videoSearchBudgetDay = day;
    videoSearchUnitsSpentToday = 0;
  }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.all('/api/discover/graphql', ...studentOnly, createPreferenceGraphqlHandler({
  prisma,
  getVocab: () => vocab,
}));

async function discoverHealth(_req, res) {
  try {
    const latest = await prisma.preferenceRefreshRun.findFirst({
      where: { status: 'done' },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true, modelVersion: true, trainingStatus: true, trainingReason: true },
    });
    const ageSeconds = latest?.completedAt
      ? Math.max(0, Math.floor((Date.now() - latest.completedAt.getTime()) / 1000))
      : null;
    return res.status(200).json({
      status: 'ok', service: 'discover', preferenceSnapshotAgeSeconds: ageSeconds,
      preferenceModelVersion: latest?.modelVersion || null,
      preferenceTrainingStatus: latest?.trainingStatus || null,
      preferenceTrainingReason: latest?.trainingReason || null,
    });
  } catch (_) {
    // Health must continue to work during first-deploy schema bootstrap.
    return res.status(200).json({ status: 'ok', service: 'discover', preferenceSnapshotAgeSeconds: null });
  }
}

app.get('/health', discoverHealth);
app.get('/api/discover/health', discoverHealth);

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function track(promise) {
  const task = Promise.resolve(promise).catch(err => {
    console.error('[discover] background task failed:', err.message);
  }).finally(() => backgroundTasks.delete(task));
  backgroundTasks.add(task);
  return task;
}

app.post('/api/discover/internal/preference-observations', requireInternalToken, asyncHandler(async (req, res) => {
  const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
  const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 12000) : '';
  if (!isValidUuid(studentId) || !isValidUuid(messageId) || !text) {
    return res.status(400).json({ error: 'studentId, messageId, and text are required.' });
  }
  const preferences = await observeTutorText(prisma, vocab, { studentId, messageId, text });
  res.status(202).json({ accepted: true, observationCount: preferences.length });
}));

app.post('/api/discover/internal/preferences/refresh', requireInternalToken, asyncHandler(async (req, res) => {
  const runKey = typeof req.body?.runKey === 'string' && req.body.runKey.trim()
    ? req.body.runKey.trim().slice(0, 80)
    : `preference:${new Date().toISOString().slice(0, 10)}`;
  const result = await refreshPreferenceProfiles(prisma, vocab, {
    runKey,
    gnnUrl: PREFERENCE_GNN_URL,
    trainerUrl: PREFERENCE_GNN_TRAINER_URL,
    decisionUrl: DECISION_SERVICE_URL,
    token: INTERNAL_SERVICE_TOKEN,
  });
  res.status(result.started ? 200 : 202).json(result);
}));

/**
 * Fire-and-forget analytics. Every type here must also be in
 * services/analytics/lib/validation.js's KNOWN_EVENT_TYPES, or the 400 is
 * swallowed here and the event vanishes. The `type: '...'` literals must stay
 * single-quoted and physically in this file — tests/event-types.test.js scans
 * for exactly that and fails an allowlisted type whose emitter lives elsewhere.
 *
 * `schoolId` is required by the route and must be a UUID, so every event this
 * service fires is student-scoped and carries it off the JWT. The hunt itself
 * is cross-school by construction (one search for "drones" serves everyone who
 * holds that node) and therefore has no honest schoolId — it is logged rather
 * than given a fabricated one.
 */
function fireAnalyticsEvent(event) {
  if (!ANALYTICS_URL || !INTERNAL_SERVICE_TOKEN) return;
  fetch(`${ANALYTICS_URL.replace(/\/+$/, '')}/api/analytics/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
    },
    body: JSON.stringify(event),
  }).catch(err => {
    console.warn('[discover] analytics event failed:', err.message);
  });
}

function toPublicArticle(article) {
  const topics = Array.isArray(article.topics) ? article.topics : [];
  return {
    id: article.id,
    title: article.title,
    summary: article.summary,
    url: article.url,
    imageUrl: article.imageUrl,
    sourceName: article.sourceName,
    category: article.category,
    categoryLabel: GENRE_LABEL.get(article.category) || article.category,
    publishedAt: article.publishedAt,
    origin: article.origin,
    // Display labels, not raw keys — the predecessor's chat-insights.js shipped
    // raw keys for a year because it property-accessed a Map.
    topics: topics.slice(0, 3).map(key => ({ key, label: vocab.labelOf(key) })),
  };
}

function toPublicVideo(video) {
  const topics = Array.isArray(video.topics) ? video.topics : [];
  return {
    id: video.id,
    title: video.title,
    summary: video.summary,
    url: video.url,
    thumbnailUrl: video.thumbnailUrl,
    channelName: video.channelName,
    durationSeconds: video.durationSeconds,
    publishedAt: video.publishedAt,
    origin: video.origin,
    topics: topics.slice(0, 3).map(key => ({ key, label: vocab.labelOf(key) })),
  };
}

// ── feed ─────────────────────────────────────────────────────────────────────
app.get('/api/discover/genres', ...studentOnly, asyncHandler(async (req, res) => {
  const grouped = await prisma.discoverArticle.groupBy({
    by: ['category'],
    where: { safetyStatus: 'approved', expiresAt: { gt: new Date() } },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map(row => [row.category, row._count._all]));

  const genres = [{ key: 'for-you', label: 'For You' }];
  for (const genre of GENRES) {
    if (counts.get(genre.key)) genres.push({ key: genre.key, label: genre.label });
  }
  res.json({ genres });
}));

app.get('/api/discover/feed', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  const now = new Date();
  const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : 'for-you';
  const limit = Math.max(1, Math.min(MAX_FEED_LIMIT, Number(req.query.limit) || 12));
  const offset = Math.max(0, Math.min(MAX_FEED_OFFSET, Number(req.query.offset) || 0));

  // Backgrounded rather than awaited: for a student not yet imported, this is
  // up to an 8s round-trip into services/ai plus up to ~400 sequential
  // seedNode upserts. Awaiting it inline meant a batch of first-time-Discover
  // students at peak load each held their feed request open that whole time
  // and each fired concurrent calls into ai at the exact moment it's already
  // busiest. The feed below renders with whatever ranking is available now
  // (an honest degradation, same as the micro-article pre-warm case) and the
  // next request benefits once the import finishes — the per-student 60s
  // backoff in bootstrap.js already makes this idempotent to call repeatedly.
  if (!await require('./preference/service').blocked(prisma, studentId, '*')) track(ensureStudentBootstrapped(prisma, vocab, {
    studentId, aiServiceUrl: AI_SERVICE_URL, token: INTERNAL_SERVICE_TOKEN, now,
  }).catch(err => console.warn('[discover] bootstrap skipped:', err.message)));

  const where = {
    safetyStatus: 'approved',
    expiresAt: { gt: now },
    ...(category && category !== 'for-you' ? { category } : {}),
  };
  let pool = await prisma.discoverArticle.findMany({
    where, orderBy: { publishedAt: 'desc' }, take: FEED_POOL_SIZE,
  });

  // Explicit dislikes and mutes are synchronous hard overrides. Inferred/GNN
  // affinities refresh daily, but a student must not keep seeing a topic after
  // directly asking for less of it.
  const blockedPreferences = await prisma.studentPreference.findMany({
    where: { studentId, OR: [{ stance: 'DISLIKE' }, { muted: true }] },
    select: { topicKey: true },
  });
  const blockedTopicKeys = new Set(blockedPreferences.map(item => item.topicKey));
  if (blockedTopicKeys.size) {
    pool = pool.filter(article => !(Array.isArray(article.topics) ? article.topics : [])
      .map(topic => typeof topic === 'string' ? topic : topic?.key)
      .some(key => blockedTopicKeys.has(key)));
  }

  if (!pool.length && RSS_ENABLED) {
    await triggerRssRefresh();
    pool = await prisma.discoverArticle.findMany({
      where, orderBy: { publishedAt: 'desc' }, take: FEED_POOL_SIZE,
    });
  }

  let ordered = pool;
  let personalised = false;
  let studentVector = null;
  if (category === 'for-you') {
    const nodes = await loadNodes(prisma, studentId, now);
    const vector = nodesToVector(nodes);
    const vectorSize = Object.keys(vector).length;
    if (vectorSize) {
      studentVector = vector;
      const explore = explorationRateFor(vectorSize);
      ordered = rankArticles(pool, vector, { now, vocab, explore }).map(row => row.article);
      personalised = true;
    } else {
      // No graph yet: a balanced spread beats ten consecutive sport stories.
      ordered = balanceNewsCategories(pool, pool.length);
    }
  }

  const page = ordered.slice(offset, offset + limit);
  // Another replica may have created a topic this process has never loaded;
  // without this its label renders as the raw key.
  await ensureTopicsLoaded(prisma, vocab, page.flatMap(a => (Array.isArray(a.topics) ? a.topics : [])));

  // Micro-article interleaving is a post-ranking insertion pass — it never
  // touches rankArticles/balanceNewsCategories/ordered above, only the
  // already-final page. This route only ever reads already-`done` cards
  // (see cards/interleave.js and maybeQueueMicroArticle below); it never
  // generates one inline, since the model call is 10-60s, far too long for a
  // hot feed request.
  const cardQueue = await prisma.academicCard.findMany({
    where: { studentId, kind: 'micro_article', status: 'done', deliveredAt: null },
    orderBy: { createdAt: 'asc' },
    take: MICRO_ARTICLE_QUEUE_FETCH,
    select: { id: true, status: true, kind: true, spec: true, provenance: true, documentIds: true, viewedAt: true, createdAt: true, failureReason: true },
  });
  const interleaved = interleaveMicroArticles(page, cardQueue, { everyN: MICRO_ARTICLE_EVERY_N, startIndex: offset });
  const usedCardIds = interleaved.filter(item => item.kind === 'micro_article').map(item => item.card.id);

  if (usedCardIds.length) {
    // Fire-and-forget: marking delivery must never block the response. A card
    // shown twice because this update lands a beat late is a harmless
    // duplicate, not a correctness problem — deliveredAt is bookkeeping for
    // the pre-warm check below, not a dedupe guarantee.
    track(prisma.academicCard.updateMany({
      where: { id: { in: usedCardIds } },
      data: { deliveredAt: now },
    }));
  }

  // Pre-warm in the background when the queue is running low. Early feed
  // loads may show zero micro-articles while the first one warms — an
  // accepted, honest degradation, not a bug to work around.
  const remainingUndelivered = cardQueue.length - usedCardIds.length;
  if (remainingUndelivered < MICRO_ARTICLE_PREWARM_THRESHOLD) {
    track(maybeQueueMicroArticle({ studentId, schoolId: req.user.schoolId }));
  }

  // Videos interleave the SAME way micro-article cards do — a post-ranking
  // insertion pass (video/interleave.js#interleaveVideos) that only ever
  // inserts before an 'article'-kind entry, so a video is always genuinely
  // between two articles, never leading the feed. The video queue itself is
  // ranked separately from the article pool (not mixed in pre-rank) via the
  // SAME rankArticles function articles use — it falls back to pure recency
  // with no profile, so this needs no separate un-personalised branch.
  // Videos only ever carry category:'interests' (hunt/video-run.js), so they
  // are only ever queued for the 'for-you' and 'interests' tabs — never their
  // own browsable genre.
  const includeVideos = category === 'for-you' || category === 'interests';
  let videoQueue = [];
  if (includeVideos) {
    const videoPool = await prisma.discoverVideo.findMany({
      where: { safetyStatus: 'approved', expiresAt: { gt: now } },
      orderBy: { publishedAt: 'desc' },
      take: FEED_VIDEO_POOL_SIZE,
    });
    videoQueue = rankArticles(videoPool, studentVector || {}, { now, vocab })
      .map(row => row.article)
      .slice(0, VIDEO_FEED_QUEUE_SIZE);
  }
  const withVideos = includeVideos
    ? interleaveVideos(interleaved, videoQueue, { everyN: VIDEO_FEED_EVERY_N, startIndex: offset })
    : interleaved;

  res.json({
    items: withVideos.map(entry => {
      if (entry.kind === 'micro_article') return { kind: 'micro_article', card: toPublicCard(entry.card) };
      if (entry.kind === 'video') return { kind: 'video', video: toPublicVideo(entry.video) };
      return { kind: 'article', article: toPublicArticle(entry.article) };
    }),
    genre: category,
    personalised,
    // Pagination math stays computed from the news-only `ordered` list — like
    // a micro-article card, a video is a bonus insertion downstream of
    // ranking, not a page-consuming item, so offset/nextOffset/total must not
    // shift because videos (or cards) were interleaved.
    offset,
    nextOffset: offset + page.length < ordered.length ? offset + page.length : null,
    total: ordered.length,
  });
}));

// Older clients lack an event ID, so retain short-window deduplication for
// compatibility. New offline queues additionally use permanent hashed receipts.
// An identical signal within a few seconds
// of another one is a retry, not two independent engagement events. Matching
// dwellMs (not just presence) is what tells a retry apart from a second,
// later dwell report for the same session, since dwellMs grows as the
// student keeps reading.
const SIGNAL_DEDUP_WINDOW_MS = 5000;

async function predatesPrivacyControl(tx, studentId, capturedAt) {
  if (!capturedAt) return false; // compatibility clients have no offline queue
  const timestamp = new Date(capturedAt).getTime();
  if (!Number.isFinite(timestamp)) return true;
  const scopeHash = createHash('sha256').update('*').digest('hex');
  const control = await tx.preferenceControl.findUnique({ where: { studentPreferenceControl: { studentId, scopeHash } } });
  return Boolean(control && timestamp <= new Date(control.updatedAt).getTime());
}

async function isDuplicateSignal(prismaClient, { studentId, articleId, kind, sessionId, dwellMs }) {
  const recent = await prismaClient.newsSignal.findFirst({
    where: {
      studentId, articleId, kind, sessionId,
      createdAt: { gte: new Date(Date.now() - SIGNAL_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { dwellMs: true },
  });
  return Boolean(recent) && recent.dwellMs === dwellMs;
}

async function isDuplicateVideoSignal(prismaClient, { studentId, videoId, kind, sessionId, dwellMs }) {
  const recent = await prismaClient.videoSignal.findFirst({
    where: {
      studentId, videoId, kind, sessionId,
      createdAt: { gte: new Date(Date.now() - SIGNAL_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { dwellMs: true },
  });
  return Boolean(recent) && recent.dwellMs === dwellMs;
}

app.post('/api/discover/signal', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  if ((req.body.studentId && req.body.studentId !== studentId) || (req.body.schoolId && req.body.schoolId !== req.user.schoolId)) {
    return res.status(403).json({ error: 'Signal belongs to another student account.' });
  }
  const eventId = req.body.eventId;
  if (eventId && !isValidUuid(eventId)) return res.status(400).json({ error: 'eventId must be a UUID.' });
  const digest = eventId ? createHash('sha256').update(`${studentId}\u0000discover\u0000${eventId}`).digest('hex') : null;
  if (await require('./preference/service').blocked(prisma, studentId, '*')) {
    return res.status(202).json({ accepted: true, personalizationPaused: true });
  }
  const articleId = typeof req.body?.articleId === 'string' ? req.body.articleId.trim() : '';
  const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
  const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() : '';
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim().slice(0, 64) : null;
  const dwellMs = Math.max(0, Math.min(MAX_DWELL_MS, Number(req.body?.dwellMs) || 0));

  if (!SIGNAL_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${SIGNAL_KINDS.join(', ')}.` });
  }
  if (articleId && videoId) return res.status(400).json({ error: 'Provide exactly one of articleId or videoId.' });
  if (!articleId && !videoId) return res.status(400).json({ error: 'A valid articleId or videoId is required.' });

  // ── video path ─────────────────────────────────────────────────────────
  if (videoId) {
    if (!isValidUuid(videoId)) return res.status(400).json({ error: 'A valid videoId is required.' });

    const video = await prisma.discoverVideo.findUnique({ where: { id: videoId } });
    if (!video) return res.status(404).json({ error: 'Video not found.' });

    if (!digest && await isDuplicateVideoSignal(prisma, { studentId, videoId, kind, sessionId, dwellMs })) {
      return res.status(202).json({ accepted: true, deduped: true });
    }

    if (kind === 'open') {
      fireAnalyticsEvent({
        type: 'discover_video_opened',
        studentId,
        schoolId: req.user.schoolId,
        metadata: { category: video.category, huntTopicKey: video.huntTopicKey },
      });
    }
    if (kind === 'dwell') {
      fireAnalyticsEvent({
        type: 'discover_video_dwell',
        studentId,
        schoolId: req.user.schoolId,
        metadata: { videoId, category: video.category, durationSeconds: Math.round(dwellMs / 1000) },
      });
    }

    const result = await withPreferenceLock(prisma, studentId, async tx => {
      if (await blocked(tx, studentId, '*')) return { accepted: true, personalizationPaused: true };
      if (await predatesPrivacyControl(tx, studentId, req.body.capturedAt)) return { accepted: true, suppressed: true };
      if (digest && await tx.preferenceReceipt.findUnique({ where: { digest } })) return { accepted: true, deduped: true };
      if (digest) await tx.preferenceReceipt.create({ data: { digest, studentId } });
      if (await isDuplicateVideoSignal(tx, { studentId, videoId, kind, sessionId, dwellMs })) return { accepted: true, deduped: true };
      await tx.videoSignal.create({ data: { studentId, videoId, kind, dwellMs, sessionId } });
      // applySignal only ever reads .category/.topics/.entities off whatever
      // it's handed — a video row runs through the SAME, unmodified function
      // that scores article signals, feeding the same interest graph.
      await applySignal(tx, { studentId, article: video, kind, dwellMs, vocab });
      if (kind !== 'impression' && kind !== 'headline_dwell') {
        await rebuildProfile(tx, studentId, { vocab });
      }
      // Channel-trust evidence is derived from this same write path: a
      // qualifying open+dwell (>=1 min watched) or a share earns one evidence
      // unit for this video's channel, evaluated with the identical
      // distinct-sessions gate interests already use (video/trust.js, which
      // imports candidateDecision/mergeEvidence from interest/promote.js
      // directly rather than reimplementing the gate).
      const qualifies = kind === 'share' || (kind === 'dwell' && dwellMs >= MIN_QUALIFYING_DWELL_MS);
      if (qualifies) {
        await recordChannelEvidence(tx, {
          channelId: video.channelId, channelName: video.channelName, sessionId, videoUrl: video.url,
        });
      }
      return { accepted: true };
    });

    return res.status(202).json(result);
  }

  // ── article path ───────────────────────────────────────────────────────
  if (!isValidUuid(articleId)) return res.status(400).json({ error: 'A valid articleId is required.' });

  const article = await prisma.discoverArticle.findUnique({ where: { id: articleId } });
  if (!article) return res.status(404).json({ error: 'Article not found.' });

  if (!digest && await isDuplicateSignal(prisma, { studentId, articleId, kind, sessionId, dwellMs })) {
    return res.status(202).json({ accepted: true, deduped: true });
  }

  if (kind === 'open') {
    fireAnalyticsEvent({
      type: 'discover_article_opened',
      studentId,
      schoolId: req.user.schoolId,
      metadata: { category: article.category, origin: article.origin, huntTopicKey: article.huntTopicKey },
    });
  }

  if (kind === 'dwell') {
    fireAnalyticsEvent({
      type: 'discover_article_dwell',
      studentId,
      schoolId: req.user.schoolId,
      metadata: { articleId, category: article.category, durationSeconds: Math.round(dwellMs / 1000) },
    });
  }

  if (kind === 'headline_dwell') {
    fireAnalyticsEvent({
      type: 'discover_headline_dwell',
      studentId,
      schoolId: req.user.schoolId,
      metadata: { articleId, category: article.category, durationSeconds: Math.round(dwellMs / 1000) },
    });
  }

  // Acknowledge only after the raw event and derived state commit. The same
  // lock as erasure prevents an in-flight signal recreating a deleted profile.
  const result = await withPreferenceLock(prisma, studentId, async tx => {
    if (await blocked(tx, studentId, '*')) return { accepted: true, personalizationPaused: true };
    if (await predatesPrivacyControl(tx, studentId, req.body.capturedAt)) return { accepted: true, suppressed: true };
    if (digest && await tx.preferenceReceipt.findUnique({ where: { digest } })) return { accepted: true, deduped: true };
    if (digest) await tx.preferenceReceipt.create({ data: { digest, studentId } });
    if (await isDuplicateSignal(tx, { studentId, articleId, kind, sessionId, dwellMs })) return { accepted: true, deduped: true };
    await tx.newsSignal.create({ data: { studentId, articleId, kind, dwellMs, sessionId } });
    await applySignal(tx, { studentId, article, kind, dwellMs, vocab });
    // An impression is one card scrolling past. Rebuilding the derived
    // profile on every one would rewrite the row dozens of times per
    // screenful for no change worth reading.
    if (kind !== 'impression' && kind !== 'headline_dwell') {
      await rebuildProfile(tx, studentId, { vocab });
    }
    return { accepted: true };
  });

  res.status(202).json(result);
}));

// A student's own reading-time view — self-view only, no teacher/parent surface
// (the privacy gate for teacher/parent access to learner-derived data doesn't
// exist yet). Pure aggregation lives in ./stats.js so it's unit-testable
// without a database.
app.get('/api/discover/stats', ...studentOnly, asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const signals = await prisma.newsSignal.findMany({
    where: { studentId: req.user.userId, createdAt: { gte: since } },
    include: { article: { select: { category: true } } },
  });
  res.json(buildReadingStats(signals, { days }));
}));

// ── the interest graph ───────────────────────────────────────────────────────
app.get('/api/discover/interests', ...studentOnly, asyncHandler(async (req, res) => {
  const nodes = await loadNodes(prisma, req.user.userId);
  await ensureTopicsLoaded(prisma, vocab, nodes.filter(n => n.kind === 'topic').map(n => n.key));

  const graph = await loadGraph(prisma, req.user.userId, { vocab });
  res.json(graph);
}));

app.get('/api/discover/candidates', ...studentOnly, asyncHandler(async (req, res) => {
  const rows = await prisma.interestCandidate.findMany({
    where: { studentId: req.user.userId, status: 'pending' },
    orderBy: [{ evidenceCount: 'desc' }, { proposedAt: 'desc' }],
    take: 3,
  });
  res.json({
    candidates: rows.map(row => ({
      id: row.id,
      key: row.key,
      label: row.label,
      cluster: row.cluster,
      evidenceCount: row.evidenceCount,
      proposedAt: row.proposedAt,
    })),
  });
}));

/**
 * The human gate.
 *
 * This endpoint is the *only* student-facing way an LLM-proposed interest turns
 * into an InterestNode, and it does nothing on its own: candidateDecision() in
 * interest/promote.js decides, and it is a pure function of the stored row and
 * the student's answer. See the comment at the top of that file before adding
 * any condition here.
 */
app.post('/api/discover/candidates/:candidateId', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  const candidateId = String(req.params.candidateId || '').trim();
  const decision = typeof req.body?.decision === 'string' ? req.body.decision.trim() : '';
  if (!isValidUuid(candidateId)) return res.status(400).json({ error: 'A valid candidateId is required.' });
  if (!['accept', 'reject'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'accept' or 'reject'." });
  }

  const candidate = await prisma.interestCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.studentId !== studentId) {
    return res.status(404).json({ error: 'Candidate not found.' });
  }

  const outcome = candidateDecision({ candidate, decision });
  const now = new Date();

  if (outcome.action === 'noop') {
    return res.status(409).json({ error: 'This suggestion has already been decided.', reason: outcome.reason });
  }

  if (outcome.action === 'reject') {
    // Tombstoned, not deleted: the unique (studentId, key) row is what stops
    // the same suggestion coming back next week.
    await prisma.interestCandidate.update({
      where: { id: candidateId },
      data: { status: 'rejected', decidedAt: now },
    });
    fireAnalyticsEvent({
      type: 'interest_rejected',
      studentId,
      schoolId: req.user.schoolId,
      metadata: { key: candidate.key },
    });
    return res.json({ decided: 'rejected', key: candidate.key });
  }

  await registerTopic(prisma, vocab, {
    key: candidate.key, label: candidate.label, cluster: candidate.cluster,
    terms: [candidate.key.replace(/-/g, ' '), candidate.label.toLowerCase()],
  });
  await setPreference(prisma, vocab, { studentId, topicKey: candidate.key, stance: 'LIKE' });
  await prisma.interestCandidate.update({
    where: { id: candidateId },
    data: { status: 'accepted', decidedAt: now },
  });
  const { summary } = await rebuildProfile(prisma, studentId, { vocab });

  fireAnalyticsEvent({
    type: 'interest_confirmed',
    studentId,
    schoolId: req.user.schoolId,
    metadata: { key: candidate.key, origin: outcome.origin, evidenceCount: candidate.evidenceCount },
  });
  res.json({ decided: 'accepted', key: candidate.key, label: candidate.label, summary });
}));

/**
 * End of a reading session — the trigger for "did anything new show up here?".
 *
 * Returns 202 immediately: the proposal is a model call, far too slow to hold a
 * request open on a phone. The client polls GET /candidates afterwards.
 */
app.post('/api/discover/session/end', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim().slice(0, 64) : null;
  track(runProposalForSession({ studentId, sessionId }));
  res.status(202).json({ accepted: true });
}));

// ── academic cards ───────────────────────────────────────────────────────────
/**
 * Ambient academic revision.
 *
 * A card is a weak area the student already has, rendered as ordinary
 * curiosity-framed feed content — "hide the intervention, not the
 * intelligence". Targeting is deterministic (cards/prioritize.js reads the
 * quiz and practice learning-context routes and ranks in plain code); the
 * model only writes the visible text from chapter excerpts we supply, and
 * never sees a decision to make.
 *
 * Generation is async for the same reason practice and visuals are: the model
 * call is 10-60s, far too long to hold a request open on a phone.
 */
async function resolveCardTarget({ studentId, schoolId }) {
  const weakAreas = await fetchWeakAreas({ studentId, schoolId });
  return selectCardTarget(weakAreas);
}

/**
 * What the client renders. The answer key is withheld until this student has
 * answered — same reasoning as services/practice: sending correctAnswer up
 * front would let it be read in devtools before answering, which would make
 * the recall signal worthless as evidence.
 */
function toPublicCard(card, { answered = false } = {}) {
  const spec = card.spec && typeof card.spec === 'object' ? card.spec : null;

  if (card.kind === 'micro_article') {
    const base = {
      cardId: card.id,
      status: card.status,
      kind: 'micro_article',
      createdAt: card.createdAt,
    };
    if (card.status !== 'done' || !spec) {
      return { ...base, failureReason: card.failureReason || null };
    }
    // No question/options/correctAnswer/answered — there is no quiz to
    // answer here, only a read-acknowledgment (see POST .../viewed below).
    return {
      ...base,
      headline: spec.headline,
      body: spec.body,
      ctaType: spec.ctaType,
      documentIds: Array.isArray(card.documentIds) ? card.documentIds : [],
      provenance: card.provenance || null,
      viewedAt: card.viewedAt || null,
    };
  }

  const base = {
    cardId: card.id,
    status: card.status,
    kind: 'academic_card',
    createdAt: card.createdAt,
  };
  if (card.status !== 'done' || !spec) {
    return { ...base, failureReason: card.failureReason || null };
  }
  return {
    ...base,
    hook: spec.hook,
    body: spec.body,
    question: spec.question,
    options: Array.isArray(spec.options) ? spec.options : [],
    conceptTag: spec.conceptTag || null,
    provenance: card.provenance || null,
    answered,
    ...(answered
      ? { correctAnswer: spec.correctAnswer, explanation: spec.explanation }
      : {}),
  };
}

/**
 * Shared by POST /api/discover/cards (student-triggered, either kind) and
 * maybeQueueMicroArticle (the feed's pre-warm background trigger, below).
 * Resolves a weak-area target, grounds it in chapter context, dedupes
 * against an existing done card of the *same kind*, and if nothing cached,
 * creates a queued row and kicks off processCardJob. Throws a typed error
 * (`err.httpStatus`) on a genuine failure — the route below translates that
 * to a response; the background caller lets track() log and swallow it.
 */
async function createOrReuseCard({ studentId, schoolId, kind }) {
  const target = await resolveCardTarget({ studentId, schoolId });
  // Not an error: a student with no card-eligible weak area is the normal
  // steady state, and inventing a target would make the card a guess.
  if (!target) return { cardId: null, status: null, reason: 'no_eligible_weak_area' };

  let context;
  try {
    context = await fetchChapterContext({ documentIds: target.documentIds });
  } catch (err) {
    console.warn('[discover] card grounding failed:', err.message);
    throw Object.assign(new Error('That chapter is not ready yet. Try again in a moment.'), { httpStatus: 502 });
  }

  const chapter = context?.chapter;
  // Same school check services/practice makes: document ids reach us through a
  // student's own weak areas, but grounding must never cross a school boundary
  // on the strength of an id alone.
  if (!chapter || String(chapter.schoolId) !== String(schoolId)) {
    throw Object.assign(new Error('That chapter is not available.'), { httpStatus: 404 });
  }

  const chunks = selectGroundingChunks(context, { limit: CARD_GROUNDING_CHUNK_LIMIT });
  if (!chunks.length) {
    throw Object.assign(new Error('There is not enough readable text in this chapter yet to build a card from.'), { httpStatus: 422 });
  }

  const chapterKey = chapterKeyFor(chapter);
  const contentFingerprint = chapter.contentFingerprint || '';
  const targetWeakArea = target.label.slice(0, 160);

  // Same-student dedupe only, keyed on the weak area and the kind as well as
  // the chapter: an MCQ card and a micro-article for the same chapter+weak
  // area must not collide in this lookup (academic_cards_cache_idx includes
  // kind for exactly this reason). Nothing generated for one student is ever
  // served to another, and a card built for a different weak area in the
  // same chapter is not a valid hit.
  const cached = await prisma.academicCard.findFirst({
    where: { studentId, chapterKey, contentFingerprint, targetWeakArea, kind, status: 'done' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (cached) return { cardId: cached.id, status: cached.status, cached: true };

  const card = await prisma.academicCard.create({
    data: {
      studentId,
      schoolId,
      status: 'queued',
      kind,
      chapterKey,
      contentFingerprint,
      targetWeakArea,
      sourceService: String(target.sourceService || '').slice(0, 16),
      documentIds: target.documentIds.slice(0, 8),
    },
    select: { id: true, status: true },
  });

  track(processCardJob(card.id, { chapter, chunks, targetConcept: target.label, kind }));

  return { cardId: card.id, status: card.status, cached: false };
}

app.post('/api/discover/cards', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  const schoolId = req.user.schoolId;
  // Default preserves today's behavior exactly for any caller that doesn't
  // pass kind — every existing consumer asks for the MCQ shape.
  const kind = req.body?.kind === 'micro_article' ? 'micro_article' : 'mcq_card';

  let result;
  try {
    result = await createOrReuseCard({ studentId, schoolId, kind });
  } catch (err) {
    return res.status(err.httpStatus || 500).json({ error: err.message });
  }

  if (!result.cardId) return res.status(200).json({ cardId: null, status: null, reason: result.reason });
  res.status(result.cached ? 200 : 202).json({ cardId: result.cardId, status: result.status });
}));

/**
 * The student's own cards, newest first — this is what the feed interleaves.
 * Done cards only: a queued one has nothing to render, and a failed one is an
 * operational fact, not something to show a student in their feed.
 */
app.get('/api/discover/cards', ...studentOnly, asyncHandler(async (req, res) => {
  const studentId = req.user.userId;
  const limit = Math.max(1, Math.min(MAX_CARD_LIMIT, Number(req.query.limit) || 5));

  const cards = await prisma.academicCard.findMany({
    where: { studentId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, status: true, kind: true, spec: true, provenance: true, documentIds: true, viewedAt: true, failureReason: true, createdAt: true,
      attempts: { where: { studentId }, select: { id: true }, take: 1 },
    },
  });

  res.json({
    cards: cards.map(card => toPublicCard(card, { answered: card.attempts.length > 0 })),
  });
}));

app.get('/api/discover/cards/:cardId', ...studentOnly, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.cardId)) return res.status(404).json({ error: 'Card not found.' });

  const card = await prisma.academicCard.findFirst({
    where: { id: req.params.cardId, studentId: req.user.userId },
    select: {
      id: true, status: true, kind: true, spec: true, provenance: true, documentIds: true, viewedAt: true, failureReason: true, createdAt: true,
      attempts: { where: { studentId: req.user.userId }, select: { id: true }, take: 1 },
    },
  });
  if (!card) return res.status(404).json({ error: 'Card not found.' });

  res.json(toPublicCard(card, { answered: card.attempts.length > 0 }));
}));

/**
 * Micro-recall capture.
 *
 * Exactly one attempt counts per card, deliberately. A card that could be
 * re-answered would let one concept contribute unboundedly many "misses" to
 * the weak-area aggregation downstream, which would corrupt the very signal
 * the loop exists to close. Grading is exact match in plain code — no LLM,
 * no fuzzy matching (that logic stays in services/quiz's scorer).
 */
app.post('/api/discover/cards/:cardId/attempt', ...studentOnly, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.cardId)) return res.status(404).json({ error: 'Card not found.' });

  const studentId = req.user.userId;
  const card = await prisma.academicCard.findFirst({
    where: { id: req.params.cardId, studentId, status: 'done' },
    select: { id: true, spec: true },
  });
  if (!card || !card.spec) return res.status(404).json({ error: 'Card not found.' });

  const selectedAnswer = typeof req.body?.selectedAnswer === 'string'
    ? req.body.selectedAnswer.trim().slice(0, 200)
    : '';
  if (!selectedAnswer) return res.status(400).json({ error: 'selectedAnswer is required.' });

  const options = Array.isArray(card.spec.options) ? card.spec.options : [];
  if (!options.some(option => String(option).toLowerCase() === selectedAnswer.toLowerCase())) {
    return res.status(400).json({ error: 'selectedAnswer must be one of the options.' });
  }

  const existing = await prisma.academicCardAttempt.findFirst({
    where: { cardId: card.id, studentId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, correct: true, selectedAnswer: true },
  });
  if (existing) {
    return res.status(200).json({
      alreadyAnswered: true,
      correct: existing.correct,
      selectedAnswer: existing.selectedAnswer,
      correctAnswer: card.spec.correctAnswer,
      explanation: card.spec.explanation,
    });
  }

  const correct = String(card.spec.correctAnswer || '').trim().toLowerCase() === selectedAnswer.toLowerCase();
  await prisma.academicCardAttempt.create({
    data: {
      cardId: card.id,
      studentId,
      schoolId: req.user.schoolId,
      selectedAnswer,
      correct,
      answeredAt: new Date(),
    },
    select: { id: true },
  });

  fireAnalyticsEvent({
    type: 'academic_card_attempted',
    studentId,
    schoolId: req.user.schoolId,
    // No conceptTag here on purpose — see the note beside these types in
    // services/analytics/lib/validation.js. Correctness alone is what the
    // usage counters need.
    metadata: { cardId: card.id, correct },
  });

  res.status(200).json({
    alreadyAnswered: false,
    correct,
    selectedAnswer,
    correctAnswer: card.spec.correctAnswer,
    explanation: card.spec.explanation,
  });
}));

/**
 * Read-acknowledgment for a micro-article. No MCQ-attempt semantics apply —
 * a micro-article has nothing to answer, only to have been seen. Idempotent:
 * viewedAt is set at most once, so a second call is a no-op that still
 * returns 200 with the original timestamp.
 */
app.post('/api/discover/cards/:cardId/viewed', ...studentOnly, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.cardId)) return res.status(404).json({ error: 'Card not found.' });

  const studentId = req.user.userId;
  const card = await prisma.academicCard.findFirst({
    where: { id: req.params.cardId, studentId },
    select: { id: true, viewedAt: true },
  });
  if (!card) return res.status(404).json({ error: 'Card not found.' });

  if (!card.viewedAt) {
    const updated = await prisma.academicCard.update({
      where: { id: card.id },
      data: { viewedAt: new Date() },
      select: { viewedAt: true },
    });
    return res.status(200).json({ viewed: true, viewedAt: updated.viewedAt });
  }

  res.status(200).json({ viewed: true, viewedAt: card.viewedAt });
}));

async function processCardJob(cardId, { chapter, chunks, targetConcept, kind = 'mcq_card' }) {
  const claimed = await prisma.academicCard.updateMany({
    where: { id: cardId, status: 'queued' },
    data: { status: 'processing', failureReason: null },
  });
  if (claimed.count !== 1) return;

  const card = await prisma.academicCard.findUnique({
    where: { id: cardId },
    select: { id: true, studentId: true, schoolId: true, sourceService: true },
  });
  if (!card) return;

  try {
    const { spec, model, provider } = kind === 'micro_article'
      ? await generateMicroArticle({ chapter, chunks, targetConcept })
      : await generateAcademicCard({ chapter, chunks, targetConcept });

    // Both kinds' visible text must clear the same safety pass — the
    // text-collector is picked by kind so it can never be skipped for either.
    const textToScan = kind === 'micro_article' ? collectMicroArticleText(spec) : collectAcademicCardText(spec);
    const textSafety = validateGeneratedTextSafety(textToScan);
    if (!textSafety.allowed) throw new Error('The generated card did not pass the safety check.');

    await prisma.academicCard.update({
      where: { id: cardId },
      data: {
        status: 'done',
        spec,
        provenance: buildProvenance(chapter, chunks),
        model: model ? String(model).slice(0, 80) : null,
        provider: provider ? String(provider).slice(0, 24) : null,
        failureReason: null,
      },
    });

    fireAnalyticsEvent({
      type: 'academic_card_generated',
      studentId: card.studentId,
      schoolId: card.schoolId,
      subject: chapter.subject,
      metadata: {
        cardId,
        chapterNumber: chapter.chapterNumber,
        chapterName: chapter.chapterName,
        sourceService: card.sourceService || null,
        provider: provider || null,
        kind,
      },
    });
  } catch (err) {
    console.warn(`[discover] card ${cardId} generation failed:`, err.message);
    await prisma.academicCard.update({
      where: { id: cardId },
      data: { status: 'failed', failureReason: buildCardFailureReason(err) },
    }).catch(updateErr => {
      console.error(`[discover] could not mark card ${cardId} failed:`, updateErr.message);
    });
  }
}

/** A failure reason a student can read — the raw error can name a provider, an HTTP body, or an env var. */
function buildCardFailureReason(err) {
  const raw = String(err?.message || '');
  if (/quota|429|rate limit|too_many_requests/i.test(raw)) return 'Cards are busy right now. Please try again in a minute.';
  if (/safety check/i.test(raw)) return 'That chapter could not be turned into a safe card.';
  if (/failed validation after/i.test(raw)) return 'A card could not be built cleanly from this chapter. Try again in a moment.';
  return 'A card could not be generated right now. Please try again later.';
}

/**
 * The feed's pre-warm trigger (see GET /api/discover/feed below). Same
 * targeting/grounding/dedupe path as a student-triggered POST /cards call,
 * via the shared createOrReuseCard, so the two paths cannot diverge. Always
 * called through track() — a background pre-warm miss (no eligible weak
 * area, grounding not ready yet, provider hiccup) is invisible to the
 * student and simply means the queue stays thin a while longer; track()'s
 * own catch logs it without throwing back into the request that triggered it.
 */
async function maybeQueueMicroArticle({ studentId, schoolId }) {
  await createOrReuseCard({ studentId, schoolId, kind: 'micro_article' });
}

// ── internal ─────────────────────────────────────────────────────────────────
/**
 * The tutor's read. Internal token only — no teacher fallback, deliberately:
 * a named student's interest profile is learner-derived data, and there is no
 * teacher/parent view over that until services/privacy exists.
 */
app.get('/api/discover/internal/interest-context', requireInternalToken, asyncHandler(async (req, res) => {
  const studentId = typeof req.query.studentId === 'string' ? req.query.studentId.trim() : '';
  if (!isValidUuid(studentId)) return res.status(400).json({ error: 'A valid studentId is required.' });

  const profile = await prisma.studentInterestProfile.findUnique({
    where: { studentId },
    select: { promptContext: true, signalCount: true, updatedAt: true },
  });
  if (await require('./preference/service').blocked(prisma, studentId, '*')) {
    return res.json({ promptContext: '', signalCount: 0, updatedAt: null, personalizationPaused: true });
  }
  res.json({
    promptContext: String(profile?.promptContext || '').slice(0, 900),
    signalCount: profile?.signalCount || 0,
    updatedAt: profile?.updatedAt || null,
  });
}));

/**
 * Card outcomes for the loop closure (Q1).
 *
 * Read by services/quiz and services/practice when they build a student's
 * learning context, so a missed micro-recall feeds the same weak-area
 * aggregation a missed quiz question does. Internal token only — no teacher
 * fallback, same posture as /interest-context above.
 *
 * Incorrect attempts only. A correct recall is not evidence of weakness, and
 * filtering here rather than at the caller means a new consumer cannot
 * accidentally count one. (Both existing clients re-check anyway.)
 */
app.get('/api/discover/internal/card-attempt-outcomes', requireInternalToken, asyncHandler(async (req, res) => {
  const studentId = typeof req.query.studentId === 'string' ? req.query.studentId.trim() : '';
  if (!isValidUuid(studentId)) return res.status(400).json({ error: 'A valid studentId is required.' });

  const attempts = await prisma.academicCardAttempt.findMany({
    where: { studentId, correct: false },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      correct: true,
      answeredAt: true,
      createdAt: true,
      card: { select: { targetWeakArea: true, documentIds: true, spec: true } },
    },
  });

  res.json({
    outcomes: attempts
      .filter(attempt => attempt.card)
      .map(attempt => ({
        label: attempt.card.targetWeakArea,
        conceptTag: attempt.card.spec && typeof attempt.card.spec === 'object'
          ? attempt.card.spec.conceptTag || null
          : null,
        documentIds: Array.isArray(attempt.card.documentIds) ? attempt.card.documentIds : [],
        answeredAt: attempt.answeredAt || attempt.createdAt,
        correct: false,
      })),
  });
}));

// ── background work ──────────────────────────────────────────────────────────
/**
 * Propose interests from what the student read in one session, then either park
 * the proposals as pending cards or promote them on repeated evidence.
 */
async function runProposalForSession({ studentId, sessionId }) {
  if (await blocked(prisma, studentId, '*')) return;
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const signals = await prisma.newsSignal.findMany({
    where: {
      studentId,
      kind: { in: ['open', 'dwell', 'share'] },
      ...(sessionId ? { sessionId } : { createdAt: { gte: since } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { article: { select: { url: true, title: true, summary: true } } },
  });

  const byUrl = new Map();
  for (const signal of signals) {
    if (signal.article?.url) byUrl.set(signal.article.url, signal.article);
  }
  const articles = [...byUrl.values()];
  if (articles.length < 2) return;

  const nodes = await loadNodes(prisma, studentId);
  const knownLabels = nodes.filter(n => n.kind === 'topic').slice(0, 20).map(n => vocab.labelOf(n.key));

  const { proposals } = await proposeInterests({ articles, knownLabels, vocab });
  if (!proposals.length) return;

  return withPreferenceLock(prisma, studentId, async prisma => {
  if (await blocked(prisma, studentId, '*')) return;
  for (const proposal of proposals) {
    if (await blocked(prisma, studentId, proposal.key)) continue;
    // Already a live interest — nothing to ask about.
    const existingNode = await prisma.interestNode.findUnique({
      where: { studentId_kind_key: { studentId, kind: 'topic', key: proposal.key } },
      select: { id: true },
    });
    if (existingNode) continue;

    const existing = await prisma.interestCandidate.findUnique({
      where: { studentId_key: { studentId, key: proposal.key } },
    });
    // A rejected candidate never comes back. The student already answered.
    if (existing && existing.status !== 'pending') continue;

    const merged = mergeEvidence({ existing, sessionId, evidenceUrls: proposal.evidenceUrls });
    const row = existing
      ? await prisma.interestCandidate.update({
        where: { id: existing.id },
        data: { evidenceCount: merged.evidenceCount, evidence: merged.evidence, label: proposal.label },
      })
      : await prisma.interestCandidate.create({
        data: {
          studentId, key: proposal.key, label: proposal.label, cluster: proposal.cluster,
          evidenceCount: merged.evidenceCount, evidence: merged.evidence,
        },
      });

    // Unattended promotion: the student never answered the card, but the same
    // interest has now shown up in enough separate sessions that a counter can
    // call it. Still not a model judgement — see interest/promote.js.
    const outcome = candidateDecision({ candidate: row });
    if (outcome.action !== 'promote') continue;

    if (proposal.topic) await registerTopic(prisma, vocab, proposal.topic);
    await applyPreference(prisma, vocab, {
      studentId, topicKey: proposal.key, stance: 'LIKE', source: 'discover', confidence: 0.45,
      eventId: `candidate:${row.id}`, evidenceRef: `candidate:${row.id}`, allowOverrideExplicit: false,
    });
    await prisma.interestCandidate.update({
      where: { id: row.id },
      data: { status: 'accepted', decidedAt: new Date() },
    });
    await rebuildProfile(prisma, studentId, { vocab });
  }
  });
}

let rssRefreshPromise = null;
function triggerRssRefresh() {
  if (!rssRefreshPromise) {
    rssRefreshPromise = refreshRssArticles(prisma, { vocab })
      .then(result => {
        if (result.errors?.length) console.warn('[discover] rss refresh partial:', result.errors.join(' | '));
        return result;
      })
      .catch(err => {
        console.error('[discover] rss refresh failed:', err.message);
        return { stored: 0, errors: [err.message] };
      })
      .finally(() => { rssRefreshPromise = null; });
  }
  return rssRefreshPromise;
}

/**
 * One scheduler tick: enqueue the topics worth hunting, then drain the queue.
 *
 * The enqueue/claim split is what makes this multi-replica safe — see the
 * header of hunt/run.js. Timers fire on every pod; only one pod wins each row.
 */
async function huntTick() {
  if (!HUNT_ENABLED) return;
  if (!searchProvider) return;

  const topics = await selectHuntTopics(prisma, {
    limit: HUNT_MAX_TOPICS_PER_RUN, cooldownMs: HUNT_TOPIC_COOLDOWN_MS, vocab,
  });
  if (topics.length) await enqueueHuntRuns(prisma, topics);

  let drained = 0;
  let totalStored = 0;
  // Bounded by what this tick enqueued, so a backlog cannot make one pod run
  // the queue forever.
  for (let i = 0; i < HUNT_MAX_TOPICS_PER_RUN; i += 1) {
    const run = await claimHuntRun(prisma);
    if (!run) break;
    const result = await executeHuntRun(prisma, run, { provider: searchProvider, vocab });
    drained += 1;
    totalStored += result.stored || 0;
  }

  // Logged, not fired at analytics: a hunt spans every school that holds the
  // topic, so there is no schoolId to attach and the events route requires one.
  // HuntRun rows are the durable record of what ran and what it found.
  if (drained) {
    console.log(`[discover] hunt tick: ${drained} run(s), ${totalStored} article(s) stored`);
  }
}

/**
 * The video hunt's own tick — runs on an independent timer (see start() below)
 * so a slow or quota-exhausted video hunt can never delay or starve the
 * article hunt's queue drain, or vice versa. Bounded by both a per-tick topic
 * cap and an in-process daily search.list quota estimate, since YouTube's
 * quota (100 units/search.list call) is far tighter than the news provider's.
 */
async function videoHuntTick() {
  if (!VIDEO_HUNT_ENABLED) return;
  if (!videoSearchProvider) return;

  const now = new Date();
  resetVideoSearchBudgetIfNewDay(now);

  const topics = await selectVideoHuntTopics(prisma, {
    limit: VIDEO_HUNT_MAX_TOPICS_PER_RUN, cooldownMs: VIDEO_HUNT_TOPIC_COOLDOWN_MS, vocab, now,
  });
  if (topics.length) await enqueueVideoHuntRuns(prisma, topics);

  let drained = 0;
  let totalStored = 0;
  // Worst-case queries-per-topic (hunt/video-queries.js's MAX_QUERIES), used
  // to decide whether starting another topic could blow the daily budget.
  const estimatedUnitsPerTopic = 4 * VIDEO_SEARCH_UNIT_COST;
  for (let i = 0; i < VIDEO_HUNT_MAX_TOPICS_PER_RUN; i += 1) {
    if (videoSearchUnitsSpentToday + estimatedUnitsPerTopic > VIDEO_HUNT_DAILY_SEARCH_BUDGET) {
      console.log('[discover] video hunt: daily search.list budget would be exceeded, stopping this tick');
      break;
    }
    const run = await claimVideoHuntRun(prisma);
    if (!run) break;
    const result = await executeVideoHuntRun(prisma, run, {
      provider: videoSearchProvider, vocab, maxChannelEnrichPerRun: VIDEO_HUNT_MAX_CHANNEL_ENRICH_PER_RUN,
    });
    // Actual spend, not the worst-case estimate — result.queries is the real
    // query set this run used (absent on a total failure before generation).
    videoSearchUnitsSpentToday += (result.queries?.length || 0) * VIDEO_SEARCH_UNIT_COST;
    drained += 1;
    totalStored += result.stored || 0;
  }

  if (drained) {
    console.log(`[discover] video hunt tick: ${drained} run(s), ${totalStored} video(s) stored`);
  }
}

// ── errors ───────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[discover] unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ── boot ─────────────────────────────────────────────────────────────────────
let huntTimer = null;
let rssTimer = null;
let videoHuntTimer = null;
let preferenceRefreshTimer = null;
let server = null;

async function start() {
  vocab = await loadVocabulary(prisma);
  console.log(`[discover] interest vocabulary loaded: ${vocab.size()} topics`);

  searchProvider = resolveSearchProvider();
  if (searchProvider) {
    console.log(`[discover] search provider: ${searchProvider.name}`);
  } else {
    // Not an error. Without a key Discover still serves the curated genres;
    // only the interest-targeted hunt lane is missing.
    console.log('[discover] no search provider configured — hunting disabled, RSS feed only');
  }

  videoSearchProvider = resolveVideoSearchProvider();
  if (videoSearchProvider) {
    console.log(`[discover] video search provider: ${videoSearchProvider.name}`);
    await seedTrustedChannels(prisma, process.env);
  } else {
    // Same fail-closed posture as the article search provider: no key means
    // no video recommendations, not a broken/degraded state.
    console.log('[discover] no YOUTUBE_API_KEY configured — video recommendations disabled');
  }

  server = app.listen(PORT, () => console.log(`[discover] listening on ${PORT}`));

  if (RSS_ENABLED) {
    setTimeout(() => track(triggerRssRefresh()), 2500).unref?.();
    rssTimer = setInterval(() => track(triggerRssRefresh()), HUNT_INTERVAL_MS);
    rssTimer.unref?.();
  }
  if (HUNT_ENABLED && searchProvider) {
    setTimeout(() => track(huntTick()), 15000).unref?.();
    huntTimer = setInterval(() => track(huntTick().catch(err => console.error('[discover] hunt tick failed:', err.message))), HUNT_INTERVAL_MS);
    huntTimer.unref?.();
  }
  if (VIDEO_HUNT_ENABLED && videoSearchProvider) {
    setTimeout(() => track(videoHuntTick()), 20000).unref?.();
    videoHuntTimer = setInterval(() => track(videoHuntTick().catch(err => console.error('[discover] video hunt tick failed:', err.message))), VIDEO_HUNT_INTERVAL_MS);
    videoHuntTimer.unref?.();
  }
  if (PREFERENCE_REFRESH_ENABLED) {
    const refresh = () => refreshPreferenceProfiles(prisma, vocab, {
      runKey: `preference:${new Date().toISOString().slice(0, 10)}`,
      gnnUrl: PREFERENCE_GNN_URL,
      trainerUrl: PREFERENCE_GNN_TRAINER_URL,
      decisionUrl: DECISION_SERVICE_URL,
      token: INTERNAL_SERVICE_TOKEN,
    });
    setTimeout(() => track(refresh()), 30000).unref?.();
    preferenceRefreshTimer = setInterval(() => track(refresh()), PREFERENCE_REFRESH_INTERVAL_MS);
    preferenceRefreshTimer.unref?.();
  }
}

async function shutdown(signal) {
  console.log(`[discover] ${signal} received, shutting down`);
  if (huntTimer) clearInterval(huntTimer);
  if (rssTimer) clearInterval(rssTimer);
  if (videoHuntTimer) clearInterval(videoHuntTimer);
  if (preferenceRefreshTimer) clearInterval(preferenceRefreshTimer);
  await Promise.allSettled([...backgroundTasks]);
  server?.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A stray throw outside the request path would otherwise crash the process
// silently under Node's default behavior, taking down every concurrently
// in-flight request with it — worst at peak load. Log with full context and
// exit so the container's `restart: unless-stopped` policy brings it back.
process.on('uncaughtException', err => {
  console.error('[discover] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('[discover] unhandledRejection:', reason);
  process.exit(1);
});

if (require.main === module) {
  start().catch(err => {
    console.error('[discover] failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  app, start, huntTick, videoHuntTick, triggerRssRefresh, runProposalForSession,
  HUNT_CATEGORY, PROMOTION_EVIDENCE_THRESHOLD,
};
