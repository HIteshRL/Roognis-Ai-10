/**
 * Quiz lifecycle.
 *
 * Questions are drafted by a language model. Nothing in the generator can
 * establish that an answer key is *correct* — `validateQuizDraft` checks shape
 * (option count, difficulty distribution, non-empty fields, citation ids that
 * resolve) and stops there. A key that points at the wrong option satisfies
 * every one of those checks.
 *
 * That makes a human the only correctness gate, so a generated quiz lands in
 * PENDING_REVIEW and a teacher must approve it before any student can open it.
 * Before this existed, generation *was* publication: quizzes were created
 * `ready` and the student endpoints read exactly that, so an LLM published
 * assessment items to children with nobody in the loop.
 *
 * Getting a key wrong is not a cosmetic error either — `gradeQuizAttempt` mints
 * a `weakAreaLabel` from every incorrect answer, so a bad key marks a correct
 * child wrong *and* manufactures a weakness that surfaces on the teacher
 * dashboard.
 *
 *   PENDING_REVIEW ──approve──> READY ──superseded──> ARCHIVED
 *         │                                              ▲
 *         └──────────── superseded ──────────────────────┘
 */
const QUIZ_STATUS = {
  PENDING_REVIEW: 'pending_review',
  READY: 'ready',
  ARCHIVED: 'archived',
};

/** Statuses a student may open. Deliberately only one. */
const STUDENT_VISIBLE_STATUSES = [QUIZ_STATUS.READY];

/**
 * Statuses that occupy the "current quiz" slot for a chapter.
 *
 * A quiz awaiting review is still the live one — regenerating over it would
 * discard the teacher's pending decision and re-spend the model call.
 */
const ACTIVE_STATUSES = [QUIZ_STATUS.PENDING_REVIEW, QUIZ_STATUS.READY];

const isStudentVisible = (status) => STUDENT_VISIBLE_STATUSES.includes(status);
const isActive = (status) => ACTIVE_STATUSES.includes(status);

/**
 * Whether an approval may proceed, and what to say when it may not.
 *
 * This lives here rather than inline in the route because it is the gate that
 * decides what reaches a child: it has to be checkable without a database.
 *
 * Approving an already-approved quiz is a 409 rather than a silent success —
 * a double-submit must not be able to look like a second reviewer having
 * independently checked the answer keys.
 */
function approvalDecision(status) {
  if (status === QUIZ_STATUS.READY) {
    return { ok: false, httpStatus: 409, error: 'Quiz is already approved.' };
  }
  if (status !== QUIZ_STATUS.PENDING_REVIEW) {
    return { ok: false, httpStatus: 409, error: `Cannot approve a quiz that is ${status}.` };
  }
  return { ok: true };
}

module.exports = {
  QUIZ_STATUS,
  STUDENT_VISIBLE_STATUSES,
  ACTIVE_STATUSES,
  isStudentVisible,
  isActive,
  approvalDecision,
};
