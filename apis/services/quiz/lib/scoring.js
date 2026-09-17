function gradeQuizAttempt(quiz, rawAnswers = {}) {
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  const answers = normalizeSubmittedAnswers(rawAnswers, questions);
  const results = questions.map(question => {
    const studentAnswer = answers[question.id] ?? '';
    const correct = isCorrectAnswer(question, studentAnswer);
    const marks = Number(question.marks || 1);
    return {
      questionId: question.id,
      order: question.orderIndex,
      type: question.type,
      difficulty: question.difficulty,
      conceptTag: question.conceptTag,
      conceptId: question.conceptId,
      misconceptionIds: Array.isArray(question.misconceptionIds) ? question.misconceptionIds : [],
      weakAreaLabel: question.weakAreaLabel,
      prompt: question.prompt,
      studentAnswer,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      marks,
      awardedMarks: correct ? marks : 0,
      correct,
    };
  });

  const score = results.reduce((sum, item) => sum + item.awardedMarks, 0);
  const maxScore = results.reduce((sum, item) => sum + item.marks, 0);
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0;
  const weakAreas = results
    .filter(item => !item.correct && item.weakAreaLabel)
    .map(item => ({
      label: item.weakAreaLabel,
      conceptTag: item.conceptTag,
      conceptId: item.conceptId,
      misconceptionIds: item.misconceptionIds,
      difficulty: item.difficulty,
      questionId: item.questionId,
    }));

  return {
    answers,
    results,
    score,
    maxScore,
    percentage,
    correctCount: results.filter(item => item.correct).length,
    questionCount: results.length,
    weakAreas,
  };
}

function normalizeSubmittedAnswers(rawAnswers, questions = []) {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) return {};
  const questionIds = new Set(questions.map(question => question.id));
  const answers = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    if (!questionIds.has(key)) continue;
    answers[key] = normalizeAnswerText(value).slice(0, 2000);
  }
  return answers;
}

function isCorrectAnswer(question, answer) {
  const studentAnswer = normalizeComparable(answer);
  const correctAnswer = normalizeComparable(question?.correctAnswer);
  if (!studentAnswer || !correctAnswer) return false;
  if (studentAnswer === correctAnswer) return true;

  if (question?.type === 'short_answer') {
    return isReasonableShortAnswerMatch(studentAnswer, correctAnswer);
  }

  return false;
}

/**
 * Minimum length before a containment match is trustworthy.
 *
 * Below this, substring containment is dominated by accidents: "ice" is inside
 * "nice", "7" is inside "17", "mass" is inside "biomass". A short key must be
 * matched exactly (handled by the caller) or not at all.
 */
const MIN_CONTAINMENT_LENGTH = 12;

/**
 * Negations the student may have added that the key does not contain.
 *
 * Both matching paths below are bag-of-words, and a bag of words cannot see
 * polarity: "carbon dioxide and water" and "not carbon dioxide and water" share
 * every meaningful token. Without this check the token path scores a flat
 * contradiction as a perfect answer.
 */
const NEGATIONS = ['not', 'no', 'never', 'none', 'neither', 'nor', 'cannot', 'false', 'isnt', 'arent', 'doesnt', 'dont', 'wasnt', 'werent'];

function negationTokens(text) {
  // `normalizeComparable` has already dropped apostrophes, so "isn't" arrives
  // as "isnt". Compare on whole tokens so "nothing" is not read as "not".
  const tokens = new Set(text.split(' '));
  return NEGATIONS.filter(word => tokens.has(word));
}

/** True when the student negated something the key did not. */
function introducesNegation(studentAnswer, correctAnswer) {
  const added = negationTokens(studentAnswer);
  if (added.length === 0) return false;
  const already = new Set(negationTokens(correctAnswer));
  return added.some(word => !already.has(word));
}

/** Whole-token containment, so "ice" does not match inside "nice". */
function containsAsTokens(haystack, needle) {
  const hay = haystack.split(' ');
  const pin = needle.split(' ');
  if (pin.length === 0 || pin.length > hay.length) return false;
  return hay.some((_, i) => pin.every((token, j) => hay[i + j] === token));
}

function isReasonableShortAnswerMatch(studentAnswer, correctAnswer) {
  // A contradiction is never a correct answer, however well the words line up.
  if (introducesNegation(studentAnswer, correctAnswer)) return false;

  // Containment is only allowed for keys long enough that an accidental match
  // is implausible, and only on token boundaries. The previous guard here —
  // `min(studentLen, correctLen) >= min(12, correctLen)` — was vacuously true
  // for any key under 12 characters, so bare containment scored full marks.
  if (correctAnswer.length >= MIN_CONTAINMENT_LENGTH) {
    if (containsAsTokens(studentAnswer, correctAnswer) || containsAsTokens(correctAnswer, studentAnswer)) {
      return true;
    }
  }

  const studentTokens = meaningfulTokens(studentAnswer);
  const correctTokens = meaningfulTokens(correctAnswer);
  if (correctTokens.length < 3) return false;
  const overlap = correctTokens.filter(token => studentTokens.includes(token)).length;
  return overlap / correctTokens.length >= 0.72;
}

function normalizeAnswerText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function normalizeComparable(value) {
  return normalizeAnswerText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.%/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(value) {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'by',
    'for',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
  ]);
  return normalizeComparable(value)
    .split(' ')
    .filter(token => token.length > 2 && !stopWords.has(token));
}

module.exports = {
  gradeQuizAttempt,
  normalizeSubmittedAnswers,
  isCorrectAnswer,
};
