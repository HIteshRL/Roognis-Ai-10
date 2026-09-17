/**
 * Deterministic spaced-repetition scheduler for flashcard review.
 *
 * Pure and LLM-free by design — CLAUDE.md's hard rule bars an LLM from any
 * scoring/routing/learner-state-mutation path, and this decides both what a
 * student sees next and when. `now` is always passed in rather than read
 * from Date.now() inside these functions, so grading is reproducible and
 * testable without wall-clock coupling.
 *
 * Simplified SM-2: three grades instead of SM-2's 0-5 scale (enough signal
 * to grow/shrink intervals, and fits a three-button mobile flip-card UI).
 * easeFactor is stored as an integer x100 (250 = ease 2.50) to avoid float
 * drift across repeated upserts in Postgres.
 */

const GRADES = ['again', 'good', 'easy'];

const EASE_MIN = 130; // x100 → 1.30, SM-2's floor
const EASE_MAX = 300; // x100 → 3.00
const EASE_DEFAULT = 250; // x100 → 2.50, SM-2's starting ease
const EASE_AGAIN_PENALTY = 20;
const EASE_EASY_BONUS = 15;

const AGAIN_DELAY_MS = 10 * 60 * 1000; // re-show within the same session
const MAX_INTERVAL_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function initialState() {
  return {
    repetitions: 0,
    intervalDays: 0,
    easeFactor: EASE_DEFAULT,
    lapses: 0,
  };
}

function clampEase(ease) {
  return Math.min(EASE_MAX, Math.max(EASE_MIN, ease));
}

function clampIntervalDays(days) {
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, days));
}

/**
 * Advance a card's review state by one grade.
 *
 * `state` is the card's current { repetitions, intervalDays, easeFactor,
 * lapses } (use initialState() for a never-reviewed card). `now` is a Date.
 * Returns the next state plus `dueAt`, the Date the card should resurface.
 */
function gradeReview(state, grade, now) {
  if (!GRADES.includes(grade)) {
    throw new Error(`Invalid grade "${grade}" — must be one of ${GRADES.join(', ')}.`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('gradeReview requires a valid Date for `now`.');
  }
  const current = state || initialState();

  if (grade === 'again') {
    const next = {
      repetitions: 0,
      intervalDays: 0,
      easeFactor: clampEase(current.easeFactor - EASE_AGAIN_PENALTY),
      lapses: current.lapses + 1,
    };
    return { ...next, dueAt: new Date(now.getTime() + AGAIN_DELAY_MS), lastReviewedAt: now };
  }

  const repetitions = current.repetitions + 1;
  let intervalDays;
  if (repetitions === 1) {
    intervalDays = 1;
  } else if (repetitions === 2) {
    intervalDays = 3;
  } else {
    intervalDays = clampIntervalDays(Math.round((current.intervalDays || 1) * (current.easeFactor / 100)));
  }

  let easeFactor = current.easeFactor;
  if (grade === 'easy') {
    intervalDays = clampIntervalDays(Math.max(intervalDays + 1, Math.round(intervalDays * 1.3)));
    easeFactor = clampEase(easeFactor + EASE_EASY_BONUS);
  }

  return {
    repetitions,
    intervalDays,
    easeFactor,
    lapses: current.lapses,
    dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY),
    lastReviewedAt: now,
  };
}

module.exports = { GRADES, initialState, gradeReview };
