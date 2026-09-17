const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ATTENDANCE_STATUSES = new Set(['present', 'absent', 'late', 'excused']);

const KNOWN_EVENT_TYPES = [
  'chat_message',
  'feedback_submitted',
  'image_generated',
  'image_prompt_blocked',
  // A structured visual (concept map) built from a chapter's own text and
  // rendered as SVG — distinct from `image_generated`, which is the diffusion
  // path. Both feed the same "Diagrams" counters on the dashboards.
  'visual_generated',
  // AI's chapter-scoped study visual endpoint emits this separately from the
  // generic visual path. Keep it explicit so the fire-and-forget emitter is
  // accepted rather than silently 400'd at ingestion.
  'study_visual_generated',
  // services/practice — instant, ungated summary/flashcard/quiz generation.
  // Deliberately separate from the quiz_* events above, which belong to the
  // teacher-approval-gated Quiz pipeline in services/quiz; these two never
  // share a status or a gate. See CLAUDE.md / HANDOFF.md for why.
  'practice_generated',
  'practice_completed',
  // services/discover — ambient academic revision. A card is generated from a
  // weak area the student already has, and `academic_card_attempted` is the
  // micro-recall answer. Its metadata deliberately carries no conceptTag: the
  // teacher dashboard renders recent events verbatim, and the targeted concept
  // is learner-derived data about a named student, blocked until
  // services/privacy exists.
  'academic_card_generated',
  'academic_card_attempted',
  'safety_input_blocked',
  'safety_output_blocked',
  'video_recommended',
  'video_opened',
  'study_time_tracked',
  // A chapter-scoped tutor session being created *is* a lesson starting in this
  // product — see the session route in services/ai/server.js.
  'lesson_started',
  'quiz_draft_created',
  'quiz_draft_generation_failed',
  'quiz_published',
  'quiz_opened',
  'quiz_submitted',
  'quiz_graded',
  // A deterministic client-side rule (turn count on a chapter), never an LLM
  // decision — see services/ai/server.js's quiz-shown route. Distinguishes a
  // system-surfaced nudge from a student opening the quiz list unprompted.
  'quiz_nudge_shown',
  // Emitted when a student finishes onboarding. This was emitted for a long
  // time without being listed here, so every one of them was 400'd and dropped
  // by the fire-and-forget emitter.
  'student_onboarding_completed',
  // services/discover — the agentic Discover feed. discover_article_opened
  // measures what students actually read; the two interest_* events record a
  // human answering the "you seem interested in X" card, which is the gate an
  // LLM-proposed interest must pass before it becomes a graph node.
  // The hunt itself fires nothing here: it spans every school holding a topic,
  // so it has no honest schoolId, and this route requires one.
  'discover_article_opened',
  // discover_article_dwell measures actual reading time (glass-sheet open
  // duration, ms >= 2000); discover_headline_dwell measures how long a
  // headline card sits in view before being opened or scrolled past
  // (ms >= 400) — both distinct from discover_article_opened above, which
  // only measures the open action itself.
  'discover_article_dwell',
  'discover_headline_dwell',
  // Video recommendations — same shape as the article events above, mirrored
  // for DiscoverVideo/VideoSignal (services/discover/hunt/video-run.js).
  // discover_video_opened measures what students actually watch;
  // discover_video_dwell is real watch time, not a headline-preview signal
  // (there is no video equivalent of discover_headline_dwell).
  'discover_video_opened',
  'discover_video_dwell',
  'interest_confirmed',
  'interest_rejected',
  // LMS / Classroom service (services/lms) — Google-Classroom parity events
  'classroom_created',
  'student_enrolled',
  'coursework_published',
  'coursework_submitted',
  'coursework_graded',
];

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function validateAttendanceStatus(status) {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  return ATTENDANCE_STATUSES.has(normalized) ? normalized : null;
}

function validateEventType(type) {
  if (typeof type !== 'string') return null;
  const normalized = type.trim();
  return KNOWN_EVENT_TYPES.includes(normalized) ? normalized : null;
}

function validateScorePair(score, maxScore) {
  const numericScore = Number(score);
  const numericMax = maxScore === undefined || maxScore === null ? 100 : Number(maxScore);

  if (!Number.isFinite(numericScore) || !Number.isFinite(numericMax))
    return { error: 'score and maxScore must be numbers.' };

  if (numericMax <= 0)
    return { error: 'maxScore must be greater than 0.' };

  if (numericScore < 0)
    return { error: 'score must be greater than or equal to 0.' };

  if (numericScore > numericMax)
    return { error: 'score must be less than or equal to maxScore.' };

  return { score: numericScore, maxScore: numericMax };
}

function normalizeSubject(subject) {
  if (typeof subject !== 'string') return 'general';
  const trimmed = subject.trim();
  return trimmed || 'general';
}

function normalizeOptionalString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

module.exports = {
  ATTENDANCE_STATUSES,
  KNOWN_EVENT_TYPES,
  isValidUuid,
  parseDateOnly,
  validateEventType,
  validateAttendanceStatus,
  validateScorePair,
  normalizeSubject,
  normalizeOptionalString,
};
