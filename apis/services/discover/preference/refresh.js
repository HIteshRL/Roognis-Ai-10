'use strict';

const { rebuildProfile, seedNode } = require('../interest/store');
const { signalWeight } = require('../interest/graph');
const { createHash } = require('node:crypto');
const { applyPreference, blocked } = require('./service');

function gatedTutorPreferences(observations, existing) {
  const groups = new Map();
  for (const row of observations) {
    if (row.confidence < 0.9) continue;
    groups.set(row.topicKey, [...(groups.get(row.topicKey) || []), row]);
  }
  const result = [];
  for (const [topicKey, rows] of groups) {
    if (existing.some(row => row.topicKey === topicKey && (row.source === 'explicit' || row.muted))) continue;
    const ordered = rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const newest = ordered[0];
    const agreeing = new Set();
    for (const row of ordered) {
      if (row.stance !== newest.stance) break;
      agreeing.add(row.eventId);
    }
    if (agreeing.size < 2) continue;
    result.push({ ...newest, source: 'tutor_text', confidence: 0.65, muted: false,
      pending: true, gateEventId: `daily:${newest.id}`, updatedAt: newest.createdAt });
  }
  return result;
}

function topicFeatures(vocab, topicKey) {
  const cluster = vocab.clusterOf(topicKey);
  // Stable, bounded content features for inductive cold start. They are not
  // student traits; the signed interaction is supplied separately.
  const hash = [...topicKey].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 17);
  return [
    (hash % 997) / 997,
    ((hash >>> 5) % 991) / 991,
    ((hash >>> 11) % 983) / 983,
    cluster === 'other' ? 1 : 0.5,
  ];
}

// Node type used to be smuggled into features[3] as a magic number, because the
// v1 contract had only one node list. Type is structural now — a per-type input
// projection in the model — so the feature slot goes back to carrying content.
function contentFeatures(vocab, key, recency = 0) {
  const values = topicFeatures(vocab, key);
  values[3] = Math.max(0, Math.min(1, recency));
  return values;
}

// Deterministic counters over rows already loaded. Not model-derived.
function studentFeatures(preferences, signalCount) {
  const likes = preferences.filter(row => row.stance === 'LIKE' && !row.muted).length;
  const dislikes = preferences.filter(row => row.stance === 'DISLIKE' || row.muted).length;
  const muted = preferences.filter(row => row.muted).length;
  return [
    Math.tanh(likes / 8),
    Math.tanh(dislikes / 8),
    preferences.length ? muted / preferences.length : 0,
    Math.tanh(signalCount / 8),
  ];
}

// Relationship is a pure function of the endpoint kinds, matching how
// interest/store.js writes the edge. Never model-chosen.
function edgeRelationship(fromKind, toKind) {
  if (fromKind === 'genre') return 'GENRE_CONTAINS';
  if (toKind === 'entity') return 'TOPIC_MENTIONS';
  return 'TOPIC_CO_OCCURS';
}

function contentTopics(value) {
  return Array.isArray(value)
    ? value.map(topic => (typeof topic === 'string' ? topic : topic?.key)).filter(Boolean)
    : [];
}

function gatedDiscoverPreferences(signals, existing, vocab) {
  const groups = new Map();
  for (const row of signals) {
    if (!row.sessionId) continue; // repeated requests in one session are correlated
    const weight = signalWeight(row.kind, row.dwellMs);
    if (!weight) continue;
    for (const topicKey of contentTopics((row.article || row.video)?.topics)) {
      if (!vocab.has(topicKey) || existing.some(item => item.topicKey === topicKey)) continue;
      groups.set(topicKey, [...(groups.get(topicKey) || []), { ...row, stance: weight > 0 ? 'LIKE' : 'DISLIKE' }]);
    }
  }
  const result = [];
  for (const [topicKey, rows] of groups) {
    const ordered = rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const newest = ordered[0], sessions = new Set(), supporting = [];
    for (const row of ordered) {
      if (row.stance !== newest.stance) break;
      if (!sessions.has(row.sessionId)) supporting.push(row.id);
      sessions.add(row.sessionId);
    }
    if (sessions.size < 2) continue;
    const digest = createHash('sha256').update(topicKey + ':' + supporting.slice(0, 2).join(':')).digest('hex');
    result.push({ id: newest.id, topicKey, stance: newest.stance, source: 'discover', confidence: 0.45,
      evidenceRef: `signal:${newest.id}`, supportingEvidence: supporting.slice(0, 2).map(id => `signal:${id}`),
      muted: false, pending: true, gateEventId: `daily-discover:${digest}`, updatedAt: newest.createdAt });
  }
  return result;
}

async function buildPreferenceGraph(prisma, vocab, studentId, preferences) {
  const [interestNodes, interestEdges, newsSignals, videoSignals] = await Promise.all([
    prisma.interestNode.findMany({ where: { studentId }, orderBy: { weight: 'desc' }, take: 300 }),
    prisma.interestEdge.findMany({ where: { studentId }, orderBy: { weight: 'desc' }, take: 500 }),
    prisma.newsSignal.findMany({
      where: { studentId, kind: { in: ['open', 'dwell', 'share', 'skip'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { article: { select: { id: true, topics: true } } },
    }),
    prisma.videoSignal.findMany({
      where: { studentId, kind: { in: ['open', 'dwell', 'share', 'skip'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { video: { select: { id: true, topics: true } } },
    }),
  ]);

  const nodes = new Map();
  const edges = [];
  const studentNode = `student:${studentId}`;
  const signalCount = newsSignals.length + videoSignals.length;
  nodes.set(studentNode, {
    nodeId: studentNode,
    nodeType: 'student',
    features: studentFeatures(preferences, signalCount),
    baselineScore: 0,
  });

  const addTopic = (key, baselineScore = 0) => {
    if (!nodes.has(key)) {
      nodes.set(key, { nodeId: key, nodeType: 'topic', features: contentFeatures(vocab, key), baselineScore });
    }
    return key;
  };

  // Explicit and promoted stances become SIGNED student edges. In v1 these rode
  // in a separate `interactions` array, which meant one signal had two
  // representations; the model now reads it from the graph like anything else.
  for (const row of preferences) {
    addTopic(row.topicKey, row.muted ? -1 : (row.stance === 'LIKE' ? row.confidence : -row.confidence));
    edges.push({
      fromId: studentNode,
      toId: row.topicKey,
      relationship: 'STUDENT_PREFERS',
      sign: (row.muted || row.stance === 'DISLIKE') ? -1 : 1,
      weight: row.source === 'explicit' ? 2 : Math.max(0.1, row.confidence),
    });
  }

  // Genre and entity nodes stay `topic`-typed: adding node types multiplies the
  // model's weight count, and the relationship already distinguishes them.
  const nodeId = (kind, key) => kind === 'topic' ? key : `${kind}:${key}`;
  for (const row of interestNodes) {
    const id = nodeId(row.kind, row.key);
    if (!nodes.has(id)) nodes.set(id, {
      nodeId: id,
      nodeType: 'topic',
      features: contentFeatures(vocab, row.key),
      baselineScore: Math.tanh(Math.max(0, row.weight) / 8),
    });
  }
  for (const edge of interestEdges) {
    const fromId = nodeId(edge.fromKind, edge.fromKey);
    const toId = nodeId(edge.toKind, edge.toKey);
    if (!nodes.has(fromId) || !nodes.has(toId)) continue;
    edges.push({
      fromId,
      toId,
      relationship: edge.relationship || edgeRelationship(edge.fromKind, edge.toKind),
      sign: edge.sign === -1 ? -1 : 1,
      weight: Math.min(10, Math.max(0.1, Number(edge.weight) || 0.1)),
    });
  }

  const addContent = (kind, signal, content) => {
    const id = `${kind}:${content.id}`;
    if (!nodes.has(id)) nodes.set(id, {
      nodeId: id,
      nodeType: kind,
      features: contentFeatures(vocab, String(content.id)),
      baselineScore: 0,
    });
    for (const topicKey of contentTopics(content.topics)) {
      addTopic(topicKey);
      // A tag is a statement about the content, not an opinion, so it is always
      // positive and always points content -> topic.
      edges.push({ fromId: id, toId: topicKey, relationship: 'CONTENT_COVERS', sign: 1, weight: 1 });
    }
    const signedWeight = signalWeight(signal.kind, signal.dwellMs);
    if (signedWeight) edges.push({
      fromId: studentNode,
      toId: id,
      relationship: 'STUDENT_ENGAGED',
      sign: signedWeight < 0 ? -1 : 1,
      weight: Math.min(10, Math.max(0.1, Math.abs(signedWeight))),
    });
  };
  newsSignals.forEach(row => addContent('article', row, row.article));
  videoSignals.forEach(row => addContent('video', row, row.video));
  return { nodes: [...nodes.values()].slice(0, 2000), edges: edges.slice(0, 20000) };
}

async function fetchPreferenceGnn({ url, token, payload }) {
  if (!url || !token) return null;
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/internal/gnn/v1/preference/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return response.json();
  } catch (_) {
    return null;
  }
}

function trainingModelVersion(runKey) {
  const suffix = String(runKey || new Date().toISOString().slice(0, 10))
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `preference-h1-${suffix}`.slice(0, 80);
}

function isReclaimableRefreshLease(run, now = new Date()) {
  return Boolean(
    run?.status === 'running'
    && run.leaseExpiresAt
    && new Date(run.leaseExpiresAt).getTime() <= now.getTime(),
  );
}

function buildPreferenceTrainingSamples(studentGraphs, maxSamples = 5000) {
  const samples = [];
  for (const { studentId, graph, preferences } of studentGraphs) {
    for (const preference of preferences) {
      if (preference.muted || !['LIKE', 'DISLIKE'].includes(preference.stance)) continue;
      const hasTarget = graph.nodes.some(node => node.nodeId === preference.topicKey && node.nodeType === 'topic');
      if (!hasTarget) continue;

      // The held-out edge must not be recoverable from either the interaction
      // list or the deterministic topic prior. This turns the daily task into
      // genuine signed-edge reconstruction instead of label memorisation.
      samples.push({
        splitGroup: studentId ? createHash('sha256').update(studentId).digest('hex') : undefined,
        nodes: graph.nodes.map(node => (node.nodeId === preference.topicKey
          ? { ...node, baselineScore: 0 }
          : node)),
        // With the student as a real node the held-out STUDENT_PREFERS edge must
        // be REMOVED from the graph. Filtering only the label would leave the
        // answer readable off the very edge being predicted.
        edges: graph.edges.filter(edge => !(
          edge.relationship === 'STUDENT_PREFERS' && edge.toId === preference.topicKey
        )),
        targetTopicId: preference.topicKey,
        targetStance: preference.stance,
      });
      if (samples.length >= maxSamples) return samples;
    }
  }
  return samples;
}

async function trainPreferenceGnn({ url, token, runKey, samples }) {
  if (!url || !token) return { attempted: false, reason: 'not_configured' };
  if (!samples.length) return { attempted: false, reason: 'no_training_samples' };
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/internal/gnn/v1/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': token },
      body: JSON.stringify({
        lane: 'preference',
        modelVersion: trainingModelVersion(runKey),
        samples,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) return { attempted: true, promoted: false, reason: `http_${response.status}` };
    return { attempted: true, ...(await response.json()) };
  } catch (_) {
    // Training is an optimisation, not a prerequisite for a valid snapshot.
    // The deterministic preference baseline remains authoritative on failure.
    return { attempted: true, promoted: false, reason: 'trainer_unavailable' };
  }
}

async function fetchPreferenceDecision({ url, token, preference, gnn }) {
  const score = (gnn?.scores || []).find(row => row.topicId === preference.topicKey);
  const baselineAffinity = preference.muted ? -1 : (preference.stance === 'LIKE' ? preference.confidence : -preference.confidence);
  const fallback = {
    topicId: preference.topicKey,
    affinity: preference.muted || preference.stance === 'DISLIKE' ? -1 : baselineAffinity,
    source: 'baseline',
    overrideApplied: preference.source === 'explicit' || preference.muted,
    ruleVersion: 'preference-baseline-v1',
    modelVersion: null,
    evidenceIds: preference.supportingEvidence || [preference.evidenceRef || `preference:${preference.id}`],
  };
  if (!url || !token) return fallback;
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/decisions/v1/preference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': token },
      body: JSON.stringify({
        topicId: preference.topicKey,
        baselineAffinity,
        gnnAffinity: score?.affinity ?? null,
        gnnEligible: Boolean(gnn?.eligible && score),
        gnnConfidence: Number(gnn?.confidence || 0),
        modelVersion: gnn?.modelVersion || null,
        hardStance: preference.muted ? 'MUTE' : (preference.source === 'explicit' ? preference.stance : null),
        evidenceIds: fallback.evidenceIds,
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return fallback;
    return response.json();
  } catch (_) {
    return fallback;
  }
}

async function refreshPreferenceProfiles(prisma, vocab, {
  runKey, gnnUrl, trainerUrl, decisionUrl, token, modelVersion = null,
}) {
  let run;
  const leaseStartedAt = new Date();
  const leaseExpiresAt = new Date(leaseStartedAt.getTime() + 2 * 60 * 60 * 1000);
  try {
    run = await prisma.preferenceRefreshRun.create({
      data: { runKey, status: 'running', leaseExpiresAt, startedAt: leaseStartedAt },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      const existing = await prisma.preferenceRefreshRun.findUnique({ where: { runKey } });
      const reclaimable = isReclaimableRefreshLease(existing, leaseStartedAt);
      if (!reclaimable) return { started: false, status: existing?.status || 'unknown', runKey };
      const claimed = await prisma.preferenceRefreshRun.updateMany({
        where: { id: existing.id, status: 'running', leaseExpiresAt: { lte: leaseStartedAt } },
        data: {
          startedAt: leaseStartedAt,
          leaseExpiresAt,
          error: null,
          trainingStatus: 'not_started',
          trainingPromoted: false,
          trainingReason: null,
          completedAt: null,
        },
      });
      if (claimed.count !== 1) return { started: false, status: 'running', runKey };
      run = await prisma.preferenceRefreshRun.findUnique({ where: { id: existing.id } });
    } else {
      throw error;
    }
  }

  let lostLease = false;
  const heartbeat = setInterval(() => {
    prisma.preferenceRefreshRun.updateMany({
      where: { id: run.id, status: 'running', startedAt: leaseStartedAt },
      data: { leaseExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    }).then(result => { if (result.count !== 1) lostLease = true; }).catch(() => { lostLease = true; });
  }, 30000);
  heartbeat.unref();
  try {
    const savedStudents = await prisma.studentPreference.findMany({
      distinct: ['studentId'],
      select: { studentId: true },
    });
    let activeModelVersion = modelVersion;
    const observedStudents = await prisma.preferenceObservation.findMany({
      where: { source: 'tutor_text', createdAt: { lte: leaseStartedAt } },
      distinct: ['studentId'], select: { studentId: true },
    });
    const engagedStudents = await prisma.interestNode.findMany({ distinct: ['studentId'], select: { studentId: true } });
    const students = [...new Map([...savedStudents, ...observedStudents, ...engagedStudents].map(row => [row.studentId, row])).values()];
    const studentGraphs = [];
    for (const { studentId } of students) {
      const rows = await prisma.studentPreference.findMany({ where: { studentId } });
      const signalWhere = { studentId, kind: { in: ['open', 'dwell', 'share', 'skip'] },
        createdAt: { lte: leaseStartedAt, gte: new Date(leaseStartedAt.getTime() - 30 * 86400000) } };
      const [news, videos] = await Promise.all([
        prisma.newsSignal.findMany({ where: signalWhere, orderBy: { createdAt: 'desc' }, take: 200, include: { article: { select: { topics: true } } } }),
        prisma.videoSignal.findMany({ where: signalWhere, orderBy: { createdAt: 'desc' }, take: 200, include: { video: { select: { topics: true } } } }),
      ]);
      rows.push(...gatedDiscoverPreferences([...news, ...videos], rows, vocab));
      const observations = await prisma.preferenceObservation.findMany({
        where: { studentId, source: 'tutor_text', createdAt: { lte: leaseStartedAt, gte: new Date(leaseStartedAt.getTime() - 30 * 86400000) } },
        orderBy: { createdAt: 'desc' }, take: 1000,
      });
      for (const pending of gatedTutorPreferences(observations, rows)) {
        if (await blocked(prisma, studentId, pending.topicKey)) continue;
        const old = rows.findIndex(row => row.topicKey === pending.topicKey);
        if (old >= 0) rows.splice(old, 1);
        rows.push(pending);
      }
      const graph = await buildPreferenceGraph(prisma, vocab, studentId, rows);
      studentGraphs.push({ studentId, preferences: rows, graph });
    }

    const training = await trainPreferenceGnn({
      url: trainerUrl,
      token,
      runKey,
      samples: buildPreferenceTrainingSamples(studentGraphs),
    });
    if (training.promoted && training.modelVersion) activeModelVersion = training.modelVersion;

    const stagedProfiles = [];
    for (const { studentId, preferences: rows, graph } of studentGraphs) {
      const result = graph.nodes.length ? await fetchPreferenceGnn({
        url: gnnUrl,
        token,
        payload: { studentId, graphVersion: 'pref-hetero-v1', ...graph },
      }) : null;
      if (result?.eligible) activeModelVersion = result.modelVersion || activeModelVersion;
      const decisions = [];
      for (const preference of rows) {
        const decision = await fetchPreferenceDecision({
          url: decisionUrl, token, preference, gnn: result,
        });
        decisions.push({ preference, decision });
      }
      stagedProfiles.push({ studentId, decisions });
    }

    // All daily preference snapshots and derived ranking nodes advance as one
    // transaction. A failed run therefore leaves the last successful state
    // intact for every student, not just for the student that failed.
    await prisma.$transaction(async tx => {
      if (lostLease) throw new Error('Preference refresh lease lost');
      const fence = await tx.preferenceRefreshRun.updateMany({
        where: { id: run.id, status: 'running', startedAt: leaseStartedAt },
        data: { leaseExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      });
      if (fence.count !== 1) throw new Error('Preference refresh lease lost');
      for (const { studentId, decisions } of stagedProfiles) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${studentId}))`;
        for (const { preference, decision } of decisions) {
          if (await blocked(tx, studentId, preference.topicKey)) continue;
          let current = await tx.studentPreference.findUnique({ where: { studentTopicPreference: { studentId, topicKey: preference.topicKey } } });
          if (preference.pending) {
            if (current?.source === 'explicit' || current?.muted) continue;
            current = await applyPreference(tx, vocab, {
              studentId, topicKey: preference.topicKey, stance: preference.stance,
              source: preference.source, confidence: preference.confidence, evidenceRef: preference.evidenceRef,
              modelVersion: preference.source === 'discover' ? 'distinct-session-engagement-v1' : 'repeated-explicit-text-v2',
              eventId: preference.gateEventId, allowOverrideExplicit: false,
            });
          } else if (!current || new Date(current.updatedAt).getTime() !== new Date(preference.updatedAt).getTime()) {
            continue;
          }
          await tx.preferenceDecisionRecord.create({
            data: {
              studentId,
              topicKey: preference.topicKey,
              affinity: decision.affinity,
              source: decision.source,
              overrideApplied: Boolean(decision.overrideApplied),
              ruleVersion: decision.ruleVersion,
              modelVersion: decision.modelVersion,
              evidenceRefs: decision.evidenceIds || [],
            },
          });
          if (preference.muted || preference.stance === 'DISLIKE' || Number(decision.affinity) <= 0.1) {
            await tx.interestNode.deleteMany({ where: { studentId, kind: 'topic', key: preference.topicKey } });
          } else {
            await seedNode(tx, {
              studentId, kind: 'topic', key: preference.topicKey,
              weight: Math.max(1, Math.min(8, Number(decision.affinity) * 8)),
              replaceWeight: true,
              origin: preference.source === 'explicit' ? 'confirmed' : 'behaviour',
            });
          }
        }
        await rebuildProfile(tx, studentId, { vocab });
      }
    }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 120000 });

    await prisma.preferenceRefreshRun.updateMany({
      where: { id: run.id, status: 'running', startedAt: leaseStartedAt },
      data: {
        status: 'done',
        profileCount: students.length,
        modelVersion: activeModelVersion,
        trainingStatus: training.attempted ? (training.promoted ? 'promoted' : 'not_promoted') : 'skipped',
        trainingPromoted: Boolean(training.promoted),
        trainingReason: training.reason || null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
    return {
      started: true,
      status: 'done',
      runKey,
      profileCount: students.length,
      modelVersion: activeModelVersion,
      training,
    };
  } catch (error) {
    await prisma.preferenceRefreshRun.updateMany({
      where: { id: run.id, status: 'running', startedAt: leaseStartedAt },
      data: {
        status: 'failed',
        error: String(error.message || error).slice(0, 1000),
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = {
  topicFeatures,
  gatedTutorPreferences,
  gatedDiscoverPreferences,
  contentFeatures,
  studentFeatures,
  edgeRelationship,
  buildPreferenceGraph,
  isReclaimableRefreshLease,
  buildPreferenceTrainingSamples,
  trainPreferenceGnn,
  fetchPreferenceDecision,
  refreshPreferenceProfiles,
};
