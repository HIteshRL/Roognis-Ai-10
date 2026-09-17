const QUESTION_COUNT = 10;
const MAX_TEXT_ANSWER_LENGTH = 300;

const DEFAULT_QUESTIONS = Object.freeze([
  {
    id: 'interests',
    category: 'interests',
    type: 'multiselect',
    prompt: 'Which things do you enjoy most outside school?',
    helper: 'Choose up to three. This helps your tutor pick examples you will enjoy.',
    options: ['Sports', 'Games', 'Music', 'Drawing and making things', 'Animals and nature', 'Space and technology'],
    maxSelections: 3,
  },
  {
    id: 'example_world',
    category: 'examples',
    type: 'select',
    prompt: 'Which kind of examples make ideas easier for you?',
    options: ['Everyday life', 'Stories and characters', 'Sports and games', 'Pictures and diagrams', 'Experiments and how things work'],
  },
  {
    id: 'explanation_style',
    category: 'explanation_style',
    type: 'multiselect',
    prompt: 'How do you like a new idea to be explained?',
    helper: 'Choose up to two.',
    options: ['Short answer first', 'Step by step', 'With a picture or diagram', 'With a story or analogy', 'With a worked example'],
    maxSelections: 2,
  },
  {
    id: 'pace',
    category: 'pace',
    type: 'select',
    prompt: 'What pace feels best when learning something new?',
    options: ['Slow and careful', 'Balanced', 'Quick, then explain more if I ask'],
  },
  {
    id: 'challenge',
    category: 'challenge',
    type: 'select',
    prompt: 'How should your tutor handle difficult questions?',
    options: ['Start easy and build up', 'Give me a medium challenge', 'Let me try a hard challenge'],
  },
  {
    id: 'interaction',
    category: 'interaction',
    type: 'select',
    prompt: 'What should your tutor do after explaining something?',
    options: ['Ask one quick check question', 'Give me a small practice task', 'Let me decide what to do next'],
  },
  {
    id: 'motivation',
    category: 'motivation',
    type: 'multiselect',
    prompt: 'What helps you keep going when learning feels difficult?',
    helper: 'Choose up to two.',
    options: ['Encouragement', 'Small goals', 'Seeing my progress', 'A fun challenge', 'A real-world reason to learn it'],
    maxSelections: 2,
  },
  {
    id: 'dislikes',
    category: 'dislikes',
    type: 'multiselect',
    prompt: 'What can make an explanation difficult or boring for you?',
    helper: 'Choose up to three.',
    options: ['Long paragraphs', 'Too many difficult words', 'Too many steps at once', 'Repeating the same thing', 'Examples that feel unrelated'],
    maxSelections: 3,
  },
  {
    id: 'confidence',
    category: 'confidence',
    type: 'select',
    prompt: 'When you are unsure, how would you like your tutor to respond?',
    options: ['Give me a hint first', 'Show one example first', 'Explain it again in a different way', 'Tell me the answer, then explain why'],
  },
  {
    id: 'learning_goal',
    category: 'goals',
    type: 'text',
    prompt: 'What would make learning with Roognis feel really helpful to you?',
    helper: 'Write one or two sentences. Do not include private information.',
    placeholder: 'For example: Help me understand ideas without making the answer too long.',
  },
]);

const SENSITIVE_QUESTION_PATTERN = /\b(address|phone|mobile number|religion|caste|income|salary|medical|diagnosis|password|full name|where do you live)\b/i;
const PERSISTENT_INSTRUCTION_PATTERN = /\b(ignore|forget|override|bypass)\b.{0,40}\b(instruction|prompt|rule|safety)|\b(system prompt|developer message|jailbreak|act as)\b/i;
const ALLOWED_TYPES = new Set(['select', 'multiselect', 'text']);
const ALLOWED_CATEGORIES = new Set(DEFAULT_QUESTIONS.map(question => question.category));

function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return cloneDefaultQuestions();

  const accepted = [];
  const usedIds = new Set();
  const usedCategories = new Set();
  for (const candidate of value) {
    if (accepted.length >= QUESTION_COUNT) break;
    const prompt = cleanText(candidate?.prompt, 180);
    const category = cleanIdentifier(candidate?.category, 40);
    const type = ALLOWED_TYPES.has(candidate?.type) ? candidate.type : null;
    const id = cleanIdentifier(candidate?.id, 50);
    if (!prompt || !ALLOWED_CATEGORIES.has(category) || !type || !id || usedIds.has(id)
      || usedCategories.has(category) || SENSITIVE_QUESTION_PATTERN.test(prompt)) continue;

    const question = { id, category, type, prompt };
    const helper = cleanText(candidate?.helper, 180);
    if (helper) question.helper = helper;

    if (type === 'text') {
      question.placeholder = cleanText(candidate?.placeholder, 160) || 'Write one or two sentences.';
    } else {
      const options = uniqueStrings(candidate?.options, 6, 80);
      if (options.length < 2) continue;
      question.options = options;
      if (type === 'multiselect') {
        question.maxSelections = clampInteger(candidate?.maxSelections, 1, Math.min(3, options.length), 2);
      }
    }

    usedIds.add(id);
    usedCategories.add(category);
    accepted.push(question);
  }

  for (const fallback of DEFAULT_QUESTIONS) {
    if (accepted.length >= QUESTION_COUNT) break;
    if (!usedCategories.has(fallback.category)) {
      accepted.push({ ...fallback, options: fallback.options ? [...fallback.options] : undefined });
      usedCategories.add(fallback.category);
    }
  }
  return accepted.slice(0, QUESTION_COUNT);
}

function normalizeAnswers(questions, value) {
  const source = isPlainObject(value) ? value : {};
  const normalized = {};
  const errors = [];

  for (const question of questions) {
    const answer = source[question.id];
    if (question.type === 'multiselect') {
      const selections = uniqueStrings(answer, question.maxSelections || 3, 80)
        .filter(item => question.options.includes(item));
      if (selections.length) normalized[question.id] = selections;
      else if (answer !== undefined && answer !== null && answer !== '') errors.push(`${question.id} has an invalid answer.`);
      continue;
    }
    if (question.type === 'select') {
      const selection = cleanText(answer, 80);
      if (selection && question.options.includes(selection)) normalized[question.id] = selection;
      else if (answer !== undefined && answer !== null && answer !== '') errors.push(`${question.id} has an invalid answer.`);
      continue;
    }
    const text = cleanText(answer, MAX_TEXT_ANSWER_LENGTH);
    if (text) normalized[question.id] = text;
    else if (answer !== undefined && answer !== null && answer !== '') errors.push(`${question.id} has an invalid answer.`);
  }

  return {
    answers: normalized,
    errors,
    answeredCount: Object.keys(normalized).length,
    complete: questions.every(question => hasAnswer(normalized[question.id])),
  };
}

function buildFallbackProfile(answers, questions = DEFAULT_QUESTIONS) {
  const byCategory = Object.fromEntries(questions.map(question => [question.category, answers[question.id]]));
  const profile = {
    interests: asArray(byCategory.interests),
    preferredExamples: asArray(byCategory.examples),
    preferredExplanationStyles: asArray(byCategory.explanation_style),
    preferredPace: byCategory.pace || 'Balanced',
    preferredChallenge: byCategory.challenge || 'Start easy and build up',
    interactionStyle: byCategory.interaction || 'Ask one quick check question',
    motivators: asArray(byCategory.motivation),
    dislikes: asArray(byCategory.dislikes),
    confidenceSupport: byCategory.confidence || 'Give me a hint first',
    learningGoals: byCategory.goals ? [byCategory.goals] : [],
    confidence: 0.72,
  };
  profile.summary = buildProfileSummary(profile);
  return profile;
}

function sanitizeLearningProfile(value, answers, questions = DEFAULT_QUESTIONS) {
  const fallback = buildFallbackProfile(answers, questions);
  const source = isPlainObject(value) ? value : {};
  const profile = {
    interests: uniqueStrings(source.interests, 6, 80).length ? uniqueStrings(source.interests, 6, 80) : fallback.interests,
    preferredExamples: uniqueStrings(source.preferredExamples, 5, 100).length
      ? uniqueStrings(source.preferredExamples, 5, 100)
      : fallback.preferredExamples,
    preferredExplanationStyles: uniqueStrings(source.preferredExplanationStyles, 5, 100).length
      ? uniqueStrings(source.preferredExplanationStyles, 5, 100)
      : fallback.preferredExplanationStyles,
    preferredPace: cleanText(source.preferredPace, 100) || fallback.preferredPace,
    preferredChallenge: cleanText(source.preferredChallenge, 100) || fallback.preferredChallenge,
    interactionStyle: cleanText(source.interactionStyle, 100) || fallback.interactionStyle,
    motivators: uniqueStrings(source.motivators, 5, 100).length ? uniqueStrings(source.motivators, 5, 100) : fallback.motivators,
    dislikes: uniqueStrings(source.dislikes, 6, 100).length ? uniqueStrings(source.dislikes, 6, 100) : fallback.dislikes,
    confidenceSupport: cleanText(source.confidenceSupport, 120) || fallback.confidenceSupport,
    learningGoals: uniqueStrings(source.learningGoals, 4, 200).length ? uniqueStrings(source.learningGoals, 4, 200) : fallback.learningGoals,
    confidence: clampNumber(source.confidence, 0.5, 0.95, fallback.confidence),
  };
  profile.summary = cleanText(source.summary, 500) || buildProfileSummary(profile);
  return profile;
}

function formatProfileForPrompt(profile) {
  if (!profile) return 'No saved personalization profile is available.';
  const lines = [
    listLine('Interests that may be useful for examples', profile.interests),
    listLine('Preferred kinds of examples', profile.preferredExamples),
    listLine('Preferred explanation styles', profile.preferredExplanationStyles),
    safePromptLine('Preferred pace', profile.preferredPace),
    safePromptLine('Challenge preference', profile.preferredChallenge),
    safePromptLine('After explaining', profile.interactionStyle),
    listLine('Helpful motivators', profile.motivators),
    listLine('Avoid when possible', profile.dislikes),
    safePromptLine('When the student is unsure', profile.confidenceSupport),
    listLine('Student goals', profile.learningGoals),
  ].filter(Boolean);

  return [
    'Personalize when it genuinely improves understanding; do not force an interest into every answer.',
    'Treat these preferences as helpful signals, not permanent facts or measures of ability.',
    ...lines,
  ].join('\n').slice(0, 2400);
}

function buildQuestionGenerationPrompt() {
  return `Create exactly ${QUESTION_COUNT} friendly onboarding questions for a school student using an AI tutor.
The quiz should take about 10 minutes and must learn non-academic preferences: interests, example preferences, explanation style, pace, challenge level, interaction style, motivation, dislikes, confidence support, and learning goals.
Do not test academic knowledge. Do not ask for private or sensitive information such as identity details, address, phone, religion, health, family finances, passwords, or personal problems.
Use age-neutral, respectful language. Most questions should be select or multiselect; include at most one short text question.
Return only JSON in this shape:
{"questions":[{"id":"short_identifier","category":"one_category","type":"select|multiselect|text","prompt":"...","helper":"optional","options":["..."],"maxSelections":2,"placeholder":"optional"}]}`;
}

function buildProfileGenerationPrompt(questions, answers) {
  const responseRows = questions.map(question => ({
    category: question.category,
    question: question.prompt,
    answer: answers[question.id],
  }));
  return `Create a conservative learning-preference profile from this student's non-academic onboarding answers.
Do not infer intelligence, diagnoses, identity, family circumstances, or sensitive traits. Do not add facts that are not supported by the answers.
The profile will be used only to adapt teaching style and examples. Return only JSON with these keys:
interests, preferredExamples, preferredExplanationStyles, preferredPace, preferredChallenge, interactionStyle, motivators, dislikes, confidenceSupport, learningGoals, summary, confidence.
All plural fields must be arrays of short strings. confidence must be between 0.5 and 0.95.
Responses:
${JSON.stringify(responseRows)}`;
}

function extractJsonObject(text) {
  if (isPlainObject(text)) return text;
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Gemini did not return a JSON object.');
  return JSON.parse(raw.slice(start, end + 1));
}

function buildProfileSummary(profile) {
  const explanation = profile.preferredExplanationStyles.length
    ? profile.preferredExplanationStyles.join(', ')
    : 'clear explanations';
  const examples = profile.preferredExamples.length
    ? profile.preferredExamples.join(', ')
    : 'relevant real-world examples';
  return `Use ${explanation}, at a ${String(profile.preferredPace).toLowerCase()} pace. Prefer ${examples}. ${profile.dislikes.length ? `Avoid ${profile.dislikes.join(', ').toLowerCase()}.` : ''}`.trim();
}

function cloneDefaultQuestions() {
  return DEFAULT_QUESTIONS.map(question => ({
    ...question,
    options: question.options ? [...question.options] : undefined,
  }));
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanIdentifier(value, maxLength) {
  const text = cleanText(value, maxLength).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  return text.replace(/^_+|_+$/g, '');
}

function uniqueStrings(value, limit, maxLength) {
  const items = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return [...new Set(items.map(item => cleanText(item, maxLength)).filter(Boolean))].slice(0, limit);
}

function asArray(value) {
  return uniqueStrings(value, 6, 200);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasAnswer(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function listLine(label, value) {
  const items = uniqueStrings(value, 6, 200).filter(item => !PERSISTENT_INSTRUCTION_PATTERN.test(item));
  return items.length ? `${label}: ${items.join(', ')}` : null;
}

function safePromptLine(label, value) {
  const text = cleanText(value, 200);
  return text && !PERSISTENT_INSTRUCTION_PATTERN.test(text) ? `${label}: ${text}` : null;
}

module.exports = {
  DEFAULT_QUESTIONS,
  QUESTION_COUNT,
  sanitizeQuestions,
  normalizeAnswers,
  buildFallbackProfile,
  sanitizeLearningProfile,
  formatProfileForPrompt,
  buildQuestionGenerationPrompt,
  buildProfileGenerationPrompt,
  extractJsonObject,
};
