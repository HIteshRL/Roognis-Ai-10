'use strict';
// Interest edges carry a sign.
//
// Before this, `applySignal` wrote `weight: Math.abs(delta) * 0.6` with nowhere
// to record direction, so a `skip` (signalWeight -0.45) incremented the very
// same row as an `open` (+1.0). Positive and negative evidence were literally
// indistinguishable once stored, which made a "signed" preference model
// impossible no matter what the model did — it would only ever see +1 edges.
//
// `applySignal` had no test at all, which is how that survived.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applySignal, loadGraph } = require('../interest/store');
const { signalWeight } = require('../interest/graph');

const ARTICLE = {
  id: 'article-1',
  category: 'technology',
  title: 'New chip speeds up machine learning',
  summary: 'The semiconductor improves neural network software.',
  publishedAt: new Date('2026-08-11T18:00:00Z'),
};

// The compound-key argument Prisma actually generates for InterestEdge. This is
// asserted, not assumed: a previous version of this file accepted whatever key
// the caller passed, so a `where` clause naming the DB constraint instead of the
// client key passed every test here and would have thrown on the first real
// signal. Keep this in sync with @@unique(..., name:) in schema.prisma.
const EDGE_KEY = 'interest_edges_student_pair_sign_key';

/** Minimal prisma double. No $transaction, so runSerializable calls straight through. */
function fakePrisma() {
  const edgeUpserts = [];
  return {
    edgeUpserts,
    interestNode: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    interestEdge: {
      upsert: async args => {
        // Mirror Prisma's own validation: an unknown compound-key argument is a
        // PrismaClientValidationError at runtime, not a silently-ignored field.
        const keys = Object.keys(args.where);
        assert.deepEqual(keys, [EDGE_KEY], `unknown compound key in where: ${keys.join(', ')}`);
        edgeUpserts.push(args);
        return {};
      },
    },
  };
}

test('an engagement signal writes positive edges', async () => {
  const prisma = fakePrisma();
  await applySignal(prisma, { studentId: 'student-a', article: ARTICLE, kind: 'open' });

  assert.ok(prisma.edgeUpserts.length > 0, 'expected edges to be written');
  for (const call of prisma.edgeUpserts) {
    assert.equal(call.where[EDGE_KEY].sign, 1);
    assert.equal(call.create.sign, 1);
    assert.ok(call.create.weight > 0, 'weight is a magnitude and stays positive');
  }
});

test('a skip writes NEGATIVE edges rather than incrementing the positive one', async () => {
  const prisma = fakePrisma();
  await applySignal(prisma, { studentId: 'student-a', article: ARTICLE, kind: 'skip' });

  assert.ok(signalWeight('skip') < 0, 'precondition: skip is negative');
  assert.ok(prisma.edgeUpserts.length > 0);
  for (const call of prisma.edgeUpserts) {
    assert.equal(call.where[EDGE_KEY].sign, -1);
    assert.equal(call.create.sign, -1);
    // Magnitude stays positive; the direction lives in `sign`, not in the number.
    assert.ok(call.create.weight > 0);
  }
});

test('open and skip target different rows for the same node pair', async () => {
  const opened = fakePrisma();
  const skipped = fakePrisma();
  await applySignal(opened, { studentId: 'student-a', article: ARTICLE, kind: 'open' });
  await applySignal(skipped, { studentId: 'student-a', article: ARTICLE, kind: 'skip' });

  const keyOf = call => {
    const k = call.where[EDGE_KEY];
    return `${k.fromKind}:${k.fromKey}->${k.toKind}:${k.toKey}#${k.sign}`;
  };
  const openKeys = new Set(opened.edgeUpserts.map(keyOf));
  const skipKeys = new Set(skipped.edgeUpserts.map(keyOf));

  assert.ok(openKeys.size > 0 && skipKeys.size > 0);
  for (const key of skipKeys) {
    assert.ok(!openKeys.has(key), `sign must separate the rows, collided on ${key}`);
  }
  // Same pairs, opposite signs — that is the whole point.
  const stripSign = key => key.replace(/#-?1$/, '');
  assert.deepEqual(
    [...new Set([...skipKeys].map(stripSign))].sort(),
    [...new Set([...openKeys].map(stripSign))].sort(),
  );
});

test('relationship is derived from the endpoint kinds, never chosen by a model', async () => {
  const prisma = fakePrisma();
  await applySignal(prisma, { studentId: 'student-a', article: ARTICLE, kind: 'open' });

  const allowed = new Set(['GENRE_CONTAINS', 'TOPIC_MENTIONS', 'TOPIC_CO_OCCURS']);
  for (const call of prisma.edgeUpserts) {
    const { fromKind, toKind } = call.create;
    assert.ok(allowed.has(call.create.relationship));
    if (fromKind === 'genre') assert.equal(call.create.relationship, 'GENRE_CONTAINS');
    else if (toKind === 'entity') assert.equal(call.create.relationship, 'TOPIC_MENTIONS');
    else assert.equal(call.create.relationship, 'TOPIC_CO_OCCURS');
  }
});

test('the client graph shows positive edges only', async () => {
  // Negative evidence exists for the signed model. Rendering it in the student's
  // own interest map would change what that map means without anyone deciding to.
  let capturedWhere = null;
  const prisma = {
    interestNode: { findMany: async () => [] },
    interestEdge: {
      findMany: async args => { capturedWhere = args.where; return []; },
    },
    studentInterestProfile: { upsert: async () => ({}) },
  };
  await loadGraph(prisma, 'student-a');
  assert.equal(capturedWhere.sign, 1);
});
