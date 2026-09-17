'use strict';
// Channel trust — the slowly-grown table that replaces "YouTube's own
// relevance order" as the niche/mainstream signal.
//
// Reuses interest/promote.js's candidateDecision()/mergeEvidence() directly
// (imported, not reimplemented): both functions only ever touch generic
// status/evidenceCount/evidence fields, so a channel earning trust through
// repeated distinct-session engagement is the SAME promotion gate an interest
// topic uses to earn a graph node, not a new bespoke one. TrustedChannel's
// three statuses (pending/trusted/blocked) fall through candidateDecision's
// existing "not 'pending' → terminal noop" branch for free — 'trusted' and
// 'blocked' both count as decided without candidateDecision needing to know
// this table's status vocabulary.

const { candidateDecision, mergeEvidence, PROMOTION_EVIDENCE_THRESHOLD } = require('../interest/promote');
const { extractTopics, DEFAULT_VOCAB } = require('../interest/graph');

// A channel earns evidence once per distinct session from a strong positive
// signal only — mirrors interest/promote.js's own asymmetry (impression/skip
// never count toward a proposal either). `open`+a qualifying `dwell` is
// evaluated by the caller (server.js's signal route, which alone knows both
// signal kinds for a given watch); `share` alone always qualifies.
const MIN_QUALIFYING_DWELL_MS = 60000; // >=1 full minute watched

const ENRICHMENT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const UPLOAD_SAMPLE_SIZE = 20;

function parseSeedChannels(value) {
  // "channelId:Label,channelId2:Label Two" — IDs, not display-name
  // substrings like services/ai's VIDEO_TRUSTED_CHANNELS, which is spoofable
  // and ambiguous across two channels sharing a name.
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [channelId, ...rest] = entry.split(':');
      return { channelId: channelId?.trim(), channelName: rest.join(':').trim() || channelId?.trim() };
    })
    .filter(row => row.channelId);
}

/** Cold-start trust list. Bypasses the evidence gate entirely, by design. */
async function seedTrustedChannels(prisma, env = process.env, { logger = console } = {}) {
  const seeds = parseSeedChannels(env.DISCOVER_VIDEO_TRUSTED_CHANNELS);
  let seeded = 0;
  for (const { channelId, channelName } of seeds) {
    await prisma.trustedChannel.upsert({
      where: { channelId },
      create: { channelId, channelName, status: 'trusted', seedSource: 'curated', promotedAt: new Date(), decidedAt: new Date() },
      // Never demote an evidence-grown or manually-decided row just because it
      // also appears in the seed list on a later boot.
      update: {},
    });
    seeded += 1;
  }
  if (seeded) logger.log?.(`[discover] seeded ${seeded} trusted video channel(s)`);
  return seeded;
}

/**
 * The niche signal: of a channel's sampled recent uploads, what share share
 * its own most common topic cluster? High for a single-person channel that
 * only ever posts one topic; low for a newsroom whose uploads span every desk.
 * Deterministic — reuses interest/graph.js's extractTopics, zero new
 * topic-detection logic, no LLM.
 */
function computeTopicNarrowness(uploadTitles, vocab = DEFAULT_VOCAB) {
  const topKeys = uploadTitles
    .map(title => extractTopics({ title, summary: '' }, vocab)[0]?.key)
    .filter(Boolean);
  if (!topKeys.length) return { topicNarrowness: null, dominantTopicKey: null };

  const counts = new Map();
  for (const key of topKeys) counts.set(key, (counts.get(key) || 0) + 1);
  let dominantTopicKey = null;
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) { dominantTopicKey = key; dominantCount = count; }
  }
  return { topicNarrowness: dominantCount / topKeys.length, dominantTopicKey };
}

/**
 * Ensure a TrustedChannel row is enriched and return it. Skips the API calls
 * (returns the cached row) when already enriched within the freshness window
 * or seeded-trusted. Enrichment failures are swallowed — a channel with no
 * cached stats just scores as 'unknown', never a hard failure of the hunt.
 */
async function ensureChannelEnriched(prisma, provider, { channelId, channelName, now = new Date(), vocab = DEFAULT_VOCAB, logger = console } = {}) {
  const existing = await prisma.trustedChannel.findUnique({ where: { channelId } });
  if (existing?.status === 'blocked') return existing;
  if (existing?.seedSource === 'curated') return existing;
  if (existing?.lastEnrichedAt && now.getTime() - existing.lastEnrichedAt.getTime() < ENRICHMENT_FRESHNESS_MS) {
    return existing;
  }

  try {
    const channelDetails = await provider.loadChannelDetails([channelId]);
    const details = channelDetails.get(channelId);
    const uploadTitles = details?.uploadsPlaylistId
      ? await provider.loadRecentUploadTitles(details.uploadsPlaylistId, { limit: UPLOAD_SAMPLE_SIZE })
      : [];
    const { topicNarrowness, dominantTopicKey } = computeTopicNarrowness(uploadTitles, vocab);

    return await prisma.trustedChannel.upsert({
      where: { channelId },
      create: {
        channelId, channelName, status: 'pending',
        subscriberCount: details?.subscriberCount ?? null,
        videoCount: details?.videoCount ?? null,
        topicNarrowness, dominantTopicKey, lastEnrichedAt: now,
      },
      update: {
        subscriberCount: details?.subscriberCount ?? null,
        videoCount: details?.videoCount ?? null,
        topicNarrowness, dominantTopicKey, lastEnrichedAt: now,
      },
    });
  } catch (err) {
    logger.warn?.(`[discover] channel enrichment failed for ${channelId}: ${err.message}`);
    // Enrichment is a bonus, never a storage gate — return whatever we had
    // (possibly nothing), and the scorer treats a missing row as 'unknown'.
    return existing || null;
  }
}

/**
 * Fold one qualifying engagement signal into a channel's evidence. Creates a
 * `pending` row on first engagement. No-ops (via candidateDecision's own
 * terminal-state handling) once a channel is already `trusted`/`blocked`.
 */
async function recordChannelEvidence(prisma, { channelId, channelName, sessionId, videoUrl, now = new Date() } = {}) {
  if (!channelId) return { action: 'noop', reason: 'no_channel' };

  const existing = await prisma.trustedChannel.findUnique({ where: { channelId } });
  const merged = mergeEvidence({ existing, sessionId, evidenceUrls: [videoUrl] });
  // candidateDecision short-circuits to noop('no_candidate') without a truthy
  // `key` — channelId plays that role here, same as an interest candidate's
  // topic key.
  const candidate = { key: channelId, status: existing?.status || 'pending', evidenceCount: merged.evidenceCount };
  const decision = candidateDecision({ candidate, evidenceThreshold: PROMOTION_EVIDENCE_THRESHOLD });

  const data = {
    channelName: existing?.channelName || channelName || channelId,
    evidence: merged.evidence,
    evidenceCount: merged.evidenceCount,
    ...(decision.action === 'promote' ? { status: 'trusted', promotedAt: now, decidedAt: now } : {}),
  };

  const row = await prisma.trustedChannel.upsert({
    where: { channelId },
    create: { channelId, status: 'pending', ...data },
    update: data,
  });
  return { action: decision.action, channel: row };
}

module.exports = {
  MIN_QUALIFYING_DWELL_MS, ENRICHMENT_FRESHNESS_MS, UPLOAD_SAMPLE_SIZE,
  parseSeedChannels, seedTrustedChannels, computeTopicNarrowness,
  ensureChannelEnriched, recordChannelEvidence,
};
