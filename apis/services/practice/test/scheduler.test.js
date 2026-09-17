const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { GRADES, initialState, gradeReview } = require('../scheduler');

const NOW = new Date('2026-08-25T00:00:00.000Z');

describe('initialState', () => {
  it('starts a never-reviewed card at rep 0, interval 0, default ease', () => {
    assert.deepEqual(initialState(), {
      repetitions: 0,
      intervalDays: 0,
      easeFactor: 250,
      lapses: 0,
    });
  });
});

describe('gradeReview — validation', () => {
  it('rejects a grade outside the closed vocabulary', () => {
    assert.throws(() => gradeReview(initialState(), 'hard', NOW), /Invalid grade/);
  });

  it('rejects a missing or invalid now', () => {
    assert.throws(() => gradeReview(initialState(), 'good', undefined), /valid Date/);
    assert.throws(() => gradeReview(initialState(), 'good', new Date('not-a-date')), /valid Date/);
  });

  it('exposes the grade vocabulary for callers to validate against', () => {
    assert.deepEqual(GRADES, ['again', 'good', 'easy']);
  });
});

describe('gradeReview — again', () => {
  it('resets repetitions and interval, and re-shows within the session', () => {
    const state = { repetitions: 3, intervalDays: 10, easeFactor: 250, lapses: 0 };
    const next = gradeReview(state, 'again', NOW);
    assert.equal(next.repetitions, 0);
    assert.equal(next.intervalDays, 0);
    assert.equal(next.lapses, 1);
    assert.equal(next.dueAt.getTime(), NOW.getTime() + 10 * 60 * 1000);
  });

  it('penalizes ease but floors it at 130', () => {
    const barelyAbove = gradeReview({ repetitions: 1, intervalDays: 1, easeFactor: 140, lapses: 0 }, 'again', NOW);
    assert.equal(barelyAbove.easeFactor, 130);

    const atFloor = gradeReview({ repetitions: 1, intervalDays: 1, easeFactor: 130, lapses: 0 }, 'again', NOW);
    assert.equal(atFloor.easeFactor, 130);
  });

  it('accumulates lapses across repeated failures', () => {
    let state = initialState();
    state = gradeReview(state, 'again', NOW);
    state = gradeReview(state, 'again', NOW);
    assert.equal(state.lapses, 2);
  });
});

describe('gradeReview — good', () => {
  it('progresses 1 day, then 3 days, then ease-scaled', () => {
    let state = initialState();
    state = gradeReview(state, 'good', NOW);
    assert.equal(state.repetitions, 1);
    assert.equal(state.intervalDays, 1);

    state = gradeReview(state, 'good', NOW);
    assert.equal(state.repetitions, 2);
    assert.equal(state.intervalDays, 3);

    state = gradeReview(state, 'good', NOW);
    assert.equal(state.repetitions, 3);
    // round(3 * 2.50) = 8
    assert.equal(state.intervalDays, 8);
  });

  it('leaves ease factor unchanged', () => {
    const state = { repetitions: 2, intervalDays: 3, easeFactor: 250, lapses: 0 };
    const next = gradeReview(state, 'good', NOW);
    assert.equal(next.easeFactor, 250);
  });

  it('sets dueAt intervalDays ahead of now', () => {
    const state = { repetitions: 1, intervalDays: 1, easeFactor: 250, lapses: 0 };
    const next = gradeReview(state, 'good', NOW);
    assert.equal(next.dueAt.getTime(), NOW.getTime() + next.intervalDays * 24 * 60 * 60 * 1000);
  });
});

describe('gradeReview — easy', () => {
  it('produces a longer interval than good would, from the same state', () => {
    const state = { repetitions: 2, intervalDays: 3, easeFactor: 250, lapses: 0 };
    const good = gradeReview(state, 'good', NOW);
    const easy = gradeReview(state, 'easy', NOW);
    assert.ok(easy.intervalDays > good.intervalDays);
  });

  it('raises ease factor but caps it at 300', () => {
    const near = gradeReview({ repetitions: 1, intervalDays: 1, easeFactor: 290, lapses: 0 }, 'easy', NOW);
    assert.equal(near.easeFactor, 300);

    const atCap = gradeReview({ repetitions: 1, intervalDays: 1, easeFactor: 300, lapses: 0 }, 'easy', NOW);
    assert.equal(atCap.easeFactor, 300);
  });
});

describe('gradeReview — interval cap', () => {
  it('never schedules further out than 365 days', () => {
    const state = { repetitions: 20, intervalDays: 300, easeFactor: 300, lapses: 0 };
    const next = gradeReview(state, 'easy', NOW);
    assert.equal(next.intervalDays, 365);
  });
});

describe('gradeReview — determinism', () => {
  it('is a pure function of (state, grade, now) — same inputs, identical output', () => {
    const state = { repetitions: 2, intervalDays: 3, easeFactor: 250, lapses: 1 };
    const a = gradeReview(state, 'good', NOW);
    const b = gradeReview(state, 'good', NOW);
    assert.deepEqual(a, b);
  });

  it('does not read the wall clock — dueAt tracks whatever now is passed in', () => {
    const state = initialState();
    const laterNow = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const a = gradeReview(state, 'good', NOW);
    const b = gradeReview(state, 'good', laterNow);
    assert.equal(b.dueAt.getTime() - a.dueAt.getTime(), laterNow.getTime() - NOW.getTime());
  });
});
