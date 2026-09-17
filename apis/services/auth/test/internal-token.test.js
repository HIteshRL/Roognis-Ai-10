const test = require('node:test');
const assert = require('node:assert/strict');

const requireInternalToken = require('../middleware/internal-token');

/* ── What this covers ─────────────────────────────────────────────────────
   The one secret gating every internal route (per CLAUDE.md, /internal/*
   routes are reachable through Traefik — the token is the only boundary),
   so a mismatch must never accidentally pass, and a wrong-length token must
   never crash the comparison instead of just failing it. ── */

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('rejects with 500 when INTERNAL_SERVICE_TOKEN is not configured', () => {
  const original = process.env.INTERNAL_SERVICE_TOKEN;
  delete process.env.INTERNAL_SERVICE_TOKEN;
  try {
    const res = mockRes();
    let nextCalled = false;
    requireInternalToken({ headers: {} }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 500);
    assert.equal(nextCalled, false);
  } finally {
    if (original !== undefined) process.env.INTERNAL_SERVICE_TOKEN = original;
  }
});

test('rejects with 401 when no token header is sent', () => {
  process.env.INTERNAL_SERVICE_TOKEN = 'the-real-token';
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('rejects with 401 on a wrong token of a different length (no crash)', () => {
  process.env.INTERNAL_SERVICE_TOKEN = 'the-real-token';
  const res = mockRes();
  let nextCalled = false;
  assert.doesNotThrow(() => {
    requireInternalToken(
      { headers: { 'x-internal-service-token': 'short' } },
      res,
      () => { nextCalled = true; },
    );
  });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('rejects with 401 on a wrong token of the same length', () => {
  process.env.INTERNAL_SERVICE_TOKEN = 'the-real-token';
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken(
    { headers: { 'x-internal-service-token': 'the-fake-token' } },
    res,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('calls next() on the correct token', () => {
  process.env.INTERNAL_SERVICE_TOKEN = 'the-real-token';
  const res = mockRes();
  let nextCalled = false;
  requireInternalToken(
    { headers: { 'x-internal-service-token': 'the-real-token' } },
    res,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});
