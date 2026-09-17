const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { KNOWN_EVENT_TYPES } = require('../lib/validation');

/* ── The defect this covers ──────────────────────────────────────────────────
   Every emitter in this system is fire-and-forget. `POST /api/analytics/event`
   rejects an unlisted type with a 400, and the caller's `.catch` swallows it —
   so an event type that is emitted but not allowlisted is dropped forever, in
   silence, and the only symptom is a dashboard card that reads zero.

   `student_onboarding_completed` sat in exactly that state: emitted on a real
   committed transaction, absent from the allowlist, discarded every time.

   The reverse failure is quieter but just as real. An allowlisted type with no
   producer is a promise the system never keeps — `video_completed` and
   `lesson_completed` were both consumed by the dashboard and never emitted by
   anything, so those counters were structurally incapable of moving.

   This scans source rather than importing it because the emitters live in
   other services with their own dependency trees, which are not installed
   here. It is a stopgap: Layer 0 replaces the allowlist with a shared
   versioned enum, and this test retires with it.                           ── */

const SERVICE_ROOT = path.resolve(__dirname, '..', '..');

const EMITTER_SOURCES = [
  'ai/server.js',
  'quiz/server.js',
  'analytics/routes/analytics.routes.js',
  // services/practice is a genuinely new deployable service (not an existing
  // emitter routing around this list) — it fires practice_generated and
  // practice_completed as single-quoted literals physically in its own
  // server.js, same discipline as the other three.
  'practice/server.js',
  // services/discover, likewise a separate deployable: discover_article_opened
  // and the two interest_* events are single-quoted literals in its server.js.
  'discover/server.js',
];

// Producers that are not literal `fireAnalyticsEvent({ type: '...' })` calls:
// the LMS service is Python, and analytics writes one type to its own table.
const PYTHON_EMITTED = [
  'classroom_created',
  'student_enrolled',
  'coursework_published',
  'coursework_submitted',
  'coursework_graded',
];

function readSource(relativePath) {
  const full = path.join(SERVICE_ROOT, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function emittedTypesIn(source) {
  // Two emission shapes exist. Most call sites pass an object literal carrying
  // `type:`; the safety paths go through a helper that takes the type as its
  // first positional argument instead.
  const objectLiteral = [...source.matchAll(/\btype:\s*'([a-z0-9_]+)'/g)];
  const positional = [...source.matchAll(/\bfire[A-Za-z]*AnalyticsEvent\(\s*'([a-z0-9_]+)'/g)];
  return [...objectLiteral, ...positional].map(match => match[1]);
}

function collectEmittedTypes() {
  const found = new Set(PYTHON_EMITTED);
  for (const relativePath of EMITTER_SOURCES) {
    const source = readSource(relativePath);
    if (!source) continue;
    for (const type of emittedTypesIn(source)) found.add(type);
  }
  return found;
}

test('every emitted event type is in the allowlist', () => {
  const allowed = new Set(KNOWN_EVENT_TYPES);
  const emitted = collectEmittedTypes();

  // Only consider identifiers that look like analytics event types, so an
  // unrelated `type: 'radio'` elsewhere in a file cannot fail this test.
  const candidates = [...emitted].filter(type => type.includes('_'));
  const unlisted = candidates.filter(type => !allowed.has(type));

  assert.deepEqual(
    unlisted,
    [],
    `these types are emitted but would be 400'd and silently dropped: ${unlisted.join(', ')}`
  );
});

test('every allowlisted event type has a producer', () => {
  const emitted = collectEmittedTypes();
  const orphans = KNOWN_EVENT_TYPES.filter(type => !emitted.has(type));

  assert.deepEqual(
    orphans,
    [],
    `these types are allowlisted and consumed but nothing emits them: ${orphans.join(', ')}`
  );
});

test('the allowlist has no duplicates', () => {
  assert.equal(new Set(KNOWN_EVENT_TYPES).size, KNOWN_EVENT_TYPES.length);
});

test('the two unobservable types stay removed', () => {
  // Videos link to search pages with no player and no playback telemetry, and
  // there is no lesson-completion state in the product. Re-adding either means
  // building the thing that observes it first.
  assert.ok(!KNOWN_EVENT_TYPES.includes('video_completed'));
  assert.ok(!KNOWN_EVENT_TYPES.includes('lesson_completed'));
});
