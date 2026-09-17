'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { seedNode, rebuildProfile } = require('../interest/store');
const { registerTopic } = require('../interest/registry');
const { extractExplicitPreferences } = require('./text-extract');

const STANCES = new Set(['LIKE', 'DISLIKE']);
const scopeHash = key => createHash('sha256').update(key).digest('hex');

async function withPreferenceLock(prisma, studentId, action) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${studentId}))`;
    return action(tx);
  }, { timeout: 30000 });
}

async function blocked(prisma, studentId, topicKey) {
  const rows = await prisma.preferenceControl.findMany({
    where: { studentId, scopeHash: { in: [scopeHash('*'), scopeHash(topicKey)] }, blocked: true },
  });
  return rows.length > 0;
}

async function setControl(tx, studentId, key, value) {
  const hash = scopeHash(key);
  await tx.preferenceControl.upsert({
    where: { studentPreferenceControl: { studentId, scopeHash: hash } },
    create: { studentId, scopeHash: hash, blocked: value }, update: { blocked: value },
  });
}

async function setCollectionEnabled(prisma, vocab, studentId, enabled) {
  return withPreferenceLock(prisma, studentId, async tx => {
    await setControl(tx, studentId, '*', !enabled);
    if (enabled) {
      await tx.studentInterestProfile.upsert({
        where: { studentId },
        create: { studentId, summary: {}, promptContext: '', importedLegacyGraphAt: new Date() },
        update: { importedLegacyGraphAt: new Date() },
      });
      await rebuildProfile(tx, studentId, { vocab });
    }
    return enabled;
  });
}

function assertStance(value) {
  const stance = String(value || '').toUpperCase();
  if (!STANCES.has(stance)) throw new Error('stance must be LIKE or DISLIKE.');
  return stance;
}

async function ensureKnownTopic(prisma, vocab, topicKey) {
  const key = String(topicKey || '').trim().toLowerCase();
  if (!key || !vocab.has(key)) throw new Error('Unknown preference topic.');
  const row = await prisma.interestTopic.findUnique({ where: { key } });
  if (!row || row.status !== 'active') throw new Error('Preference topic is unavailable.');
  return row;
}

async function applyPreference(prisma, vocab, {
  studentId, topicKey, stance, source, confidence = 1, evidenceRef = null,
  // Defaults to false: an inferred caller that forgets the flag must NOT be
  // able to overwrite a student's explicit choice. Irrelevant when
  // source === 'explicit', which short-circuits the explicitLocked check.
  modelVersion = null, eventId = randomUUID(), allowOverrideExplicit = false,
}) {
  const normalizedStance = assertStance(stance);
  await ensureKnownTopic(prisma, vocab, topicKey);
  const digest = scopeHash(`${studentId}\u0000${eventId}\u0000${topicKey}`);
  if (await prisma.preferenceReceipt.findUnique({ where: { digest } })) {
    return prisma.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey } } });
  }
  // Block BEFORE burning the idempotency receipt. The other order let a signal
  // that arrived while collection was paused consume its receipt and return
  // null, so an honest client retry after resuming was silently deduped away.
  if (source !== 'explicit' && await blocked(prisma, studentId, topicKey)) return null;
  await prisma.preferenceReceipt.create({ data: { digest, studentId } });
  const existing = await prisma.studentPreference.findUnique({
    where: { studentTopicPreference: { studentId, topicKey } },
  });
  const explicitLocked = existing?.source === 'explicit' && source !== 'explicit' && !allowOverrideExplicit;

  await prisma.preferenceObservation.upsert({
    where: { studentEventTopicObservation: { studentId, eventId, topicKey } },
    create: { studentId, eventId, topicKey, stance: normalizedStance, source, confidence, evidenceRef, modelVersion },
    update: {},
  });

  if (!explicitLocked) {
    await prisma.studentPreference.upsert({
      where: { studentTopicPreference: { studentId, topicKey } },
      create: { studentId, topicKey, stance: normalizedStance, source, confidence, evidenceRef, modelVersion, muted: false },
      update: { stance: normalizedStance, source, confidence, evidenceRef, modelVersion, muted: false, lastSeen: new Date() },
    });
    if (normalizedStance === 'LIKE') {
      await seedNode(prisma, {
        studentId, kind: 'topic', key: topicKey,
        weight: source === 'explicit' ? 5 : Math.max(1, 3 * confidence),
        origin: source === 'explicit' ? 'confirmed' : 'behaviour',
      });
    } else {
      await prisma.interestNode.deleteMany({ where: { studentId, kind: 'topic', key: topicKey } });
    }
    await rebuildProfile(prisma, studentId, { vocab });
  }
  return prisma.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey } } });
}

async function preferencesForStudent(prisma, vocab, studentId) {
  const rows = await prisma.studentPreference.findMany({
    where: { studentId },
    orderBy: [{ muted: 'desc' }, { updatedAt: 'desc' }],
  });
  return rows.map(row => ({ ...row, label: vocab.labelOf(row.topicKey) }));
}

async function setPreference(prisma, vocab, { studentId, topicKey, stance }) {
  return withPreferenceLock(prisma, studentId, async tx => {
  await setControl(tx, studentId, topicKey, false);
  return applyPreference(tx, vocab, {
    studentId, topicKey, stance, source: 'explicit', confidence: 1,
    eventId: `explicit:${randomUUID()}`,
  });
  });
}

async function mutePreference(prisma, vocab, { studentId, topicKey }) {
  return withPreferenceLock(prisma, studentId, async prisma => {
  await ensureKnownTopic(prisma, vocab, topicKey);
  const existing = await prisma.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey } } });
  const row = existing
    ? await prisma.studentPreference.update({
        where: { studentTopicPreference: { studentId, topicKey } },
        data: { muted: true, source: 'explicit', confidence: 1, lastSeen: new Date() },
      })
    : await prisma.studentPreference.create({
        data: { studentId, topicKey, stance: 'DISLIKE', source: 'explicit', confidence: 1, muted: true },
      });
  await prisma.interestNode.deleteMany({ where: { studentId, kind: 'topic', key: topicKey } });
  await rebuildProfile(prisma, studentId, { vocab });
  return { ...row, label: vocab.labelOf(topicKey) };
  });
}

async function deletePreference(prisma, vocab, { studentId, topicKey }) {
  return withPreferenceLock(prisma, studentId, async prisma => {
  await setControl(prisma, studentId, topicKey, true);
  await prisma.preferenceObservation.deleteMany({ where: { studentId, topicKey } });
  await prisma.preferenceDecisionRecord.deleteMany({ where: { studentId, topicKey } });
  await prisma.studentPreference.deleteMany({ where: { studentId, topicKey } });
  await prisma.interestNode.deleteMany({ where: { studentId, kind: 'topic', key: topicKey } });
  await prisma.interestEdge.deleteMany({ where: { studentId, OR: [{ fromKey: topicKey }, { toKey: topicKey }] } });
  await rebuildProfile(prisma, studentId, { vocab });
  return true;
  });
}

async function deletePreferenceProfile(prisma, studentId) {
  return withPreferenceLock(prisma, studentId, async prisma => {
  await setControl(prisma, studentId, '*', true);
  for (const model of ['preferenceObservation', 'preferenceDecisionRecord', 'studentPreference',
    'newsSignal', 'videoSignal', 'interestCandidate', 'interestEdge', 'interestNode', 'studentInterestProfile']) {
    await prisma[model].deleteMany({ where: { studentId } });
  }
  return true;
  });
}

async function recordContentPreference(prisma, vocab, { studentId, targetType, targetId, stance, eventId }) {
  return withPreferenceLock(prisma, studentId, async prisma => {
  const normalizedType = String(targetType || '').toUpperCase();
  let content;
  if (normalizedType === 'ARTICLE') {
    content = await prisma.discoverArticle.findUnique({ where: { id: targetId }, select: { topics: true } });
  } else if (normalizedType === 'VIDEO') {
    content = await prisma.discoverVideo.findUnique({ where: { id: targetId }, select: { topics: true } });
  } else {
    throw new Error('targetType must be ARTICLE or VIDEO.');
  }
  if (!content) throw new Error('Preference target was not found.');
  const topicKeys = (Array.isArray(content.topics) ? content.topics : [])
    .map(topic => typeof topic === 'string' ? topic : topic?.key)
    .filter(key => typeof key === 'string' && vocab.has(key))
    .slice(0, 6);
  if (!topicKeys.length) throw new Error('Preference target has no recognized topics.');
  const rows = [];
  for (const topicKey of topicKeys) {
    rows.push(await applyPreference(prisma, vocab, {
      studentId, topicKey, stance, source: 'discover', confidence: 0.6,
      evidenceRef: `${normalizedType.toLowerCase()}:${targetId}`,
      eventId,
      allowOverrideExplicit: false,
    }));
  }
  return rows.filter(Boolean);
  });
}

async function observeTutorText(prisma, vocab, { studentId, messageId, text }) {
  return withPreferenceLock(prisma, studentId, async prisma => {
  const observations = extractExplicitPreferences(text, vocab);
  const stored = [];
  for (const observation of observations) {
    if (await blocked(prisma, studentId, observation.topicKey)) continue;
    if (observation.proposedTopic) {
      await registerTopic(prisma, vocab, observation.proposedTopic);
    }
    stored.push(await prisma.preferenceObservation.upsert({
      where: { studentEventTopicObservation: { studentId, eventId: `message:${messageId}`, topicKey: observation.topicKey } },
      create: {
      studentId,
      topicKey: observation.topicKey,
      stance: observation.stance,
      source: 'tutor_text',
      confidence: observation.confidence,
      evidenceRef: `message:${messageId}`,
      modelVersion: 'explicit-text-gate-v1',
      eventId: `message:${messageId}`,
      },
      update: {},
    }));
  }
  return stored;
  });
}

module.exports = {
  applyPreference, preferencesForStudent, setPreference, mutePreference,
  deletePreference, deletePreferenceProfile, recordContentPreference,
  observeTutorText, assertStance,
  withPreferenceLock, blocked,
  setCollectionEnabled,
};
