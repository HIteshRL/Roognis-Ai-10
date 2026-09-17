/**
 * Grading a practice-quiz attempt.
 *
 * MCQ-only, exact-match — no fuzzy short-answer matching. That logic
 * (services/quiz/lib/scoring.js's isCorrectAnswer, with its negation/length/
 * token-overlap guards) lives in a different deployable service with its own
 * package.json; duplicating it here for a first cut of an ungated practice
 * flow isn't worth the risk of two matchers drifting apart. If short-answer
 * support is ever wanted here, factor isCorrectAnswer into a shared package
 * first rather than re-implementing it a third time.
 *
 * weakAreas is derived the same way services/quiz's gradeQuizAttempt does it:
 * conceptTag is set by the LLM at generation time (validate.js requires it on
 * every question), and grading just collects the tag off every wrong answer —
 * no NLP happens here.
 */


function isCorrectAnswer(question, studentAnswer) {
  return typeof studentAnswer === 'string' && studentAnswer === question.correctAnswer;
}

/**
 * Grade a submitted set of quiz answers against a stored PracticeSet.quiz.
 *
 * `rawAnswers` is `{ [questionId]: answerText }`. Missing/unknown-id answers
 * are treated as unanswered (incorrect), never as a validation error — a
 * partially-answered submission should still grade, not 400.
 */
function gradePracticeAttempt(quiz, rawAnswers = {}) {
  const questions = Array.isArray(quiz) ? quiz : [];
  const answers = {};
  const results = questions.map(question => {
    const studentAnswer = typeof rawAnswers?.[question.id] === 'string' ? rawAnswers[question.id] : null;
    answers[question.id] = studentAnswer;
    const correct = isCorrectAnswer(question, studentAnswer);
    return {
      questionId: question.id,
      prompt: question.prompt,
      conceptTag: question.conceptTag,
      conceptId: question.conceptId || null,
      misconceptionIds: Array.isArray(question.misconceptionIds) ? question.misconceptionIds : [],
      studentAnswer,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      correct,
    };
  });

  const correctCount = results.filter(item => item.correct).length;
  const questionCount = results.length;
  const score = correctCount;
  const maxScore = questionCount;
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

  const weakAreas = results
    .filter(item => !item.correct && item.conceptTag)
    .map(item => ({
      label: item.conceptTag,
      conceptTag: item.conceptTag,
      conceptId: item.conceptId,
      misconceptionIds: item.misconceptionIds,
      questionId: item.questionId,
    }));

  return { answers, results, score, maxScore, percentage, correctCount, questionCount, weakAreas };
}

module.exports = { isCorrectAnswer, gradePracticeAttempt };
