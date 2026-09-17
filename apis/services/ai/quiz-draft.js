const CHAT_COMPLETIONS_PATH = '/chat/completions';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_QUIZ_MODEL = 'openai/gpt-5-mini';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_QUIZ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_LOCAL_BASE_URL = 'http://vllm:8000/v1';
const DEFAULT_LOCAL_MODEL = 'Qwen/Qwen3-32B';
const DEFAULT_QUIZ_QUESTION_COUNT = 10;
const DIFFICULTY_WEIGHTS = [
  ['simple', 0.5],
  ['medium', 0.3],
  ['hard', 0.2],
];

const NAVIGATION_TRIVIA_PATTERNS = [
  /\b(?:write|state|name|identify|give)\s+(?:the\s+)?(?:heading|title|section name)\b/i,
  /\bwhat\s+(?:is|was)\s+(?:the\s+)?(?:heading|title|section name)\b/i,
  /\b(?:heading|title)\s+(?:used|given|shown|mentioned)\b/i,
  /\bsection\s+\d+(?:\.\d+)*\b/i,
  /\bpage\s+(?:number\s+)?\d+\b/i,
  /\b(?:figure|table|diagram)\s+\d+(?:\.\d+)*\b/i,
  /\b(?:in|from|according to)\s+(?:this|the)\s+(?:chapter|section|page|textbook|passage)\b/i,
  /\b(?:above|below)\s+(?:passage|figure|table|diagram|text)\b/i,
  /\bwhat\s+(?:comes|appears)\s+(?:before|after)\b/i,
];

const WEAK_MCQ_OPTION_PATTERNS = [
  /^(?:all|none) of the above[.!]?$/i,
  /^(?:all|none) of these[.!]?$/i,
  /^(?:both|either) [a-d](?: and| or) [a-d][.!]?$/i,
];

const quizDraftSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    chapterSummary: { type: 'string' },
    coverage: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concept: { type: 'string' },
          sourceChunkIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['concept', 'sourceChunkIds'],
      },
    },
    questions: {
      type: 'array',
      minItems: 5,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order: { type: 'integer' },
          type: { type: 'string', enum: ['mcq', 'short_answer'] },
          difficulty: { type: 'string', enum: ['simple', 'medium', 'hard'] },
          bloomLevel: {
            type: 'string',
            enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate'],
          },
          conceptTag: { type: 'string' },
          weakAreaLabel: { type: 'string' },
          prompt: { type: 'string' },
          options: {
            type: 'array',
            minItems: 0,
            maxItems: 4,
            items: { type: 'string' },
          },
          correctAnswer: { type: 'string' },
          explanation: { type: 'string' },
          sourceChunkIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          marks: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: [
          'order',
          'type',
          'difficulty',
          'bloomLevel',
          'conceptTag',
          'weakAreaLabel',
          'prompt',
          'options',
          'correctAnswer',
          'explanation',
          'sourceChunkIds',
          'marks',
        ],
      },
    },
  },
  required: ['title', 'chapterSummary', 'coverage', 'questions'],
};

function buildDifficultyPlan(questionCount = DEFAULT_QUIZ_QUESTION_COUNT) {
  const count = normalizeQuestionCount(questionCount);
  const planned = DIFFICULTY_WEIGHTS.map(([difficulty, weight], index) => {
    const exact = count * weight;
    return {
      difficulty,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      index,
    };
  });

  let assigned = planned.reduce((sum, item) => sum + item.count, 0);
  planned
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach(item => {
      if (assigned >= count) return;
      item.count += 1;
      assigned += 1;
    });

  return Object.fromEntries(planned.map(item => [item.difficulty, item.count]));
}

function normalizeQuestionCount(value) {
  const numeric = Number(value || DEFAULT_QUIZ_QUESTION_COUNT);
  if (!Number.isInteger(numeric) || numeric < 5 || numeric > 30) {
    throw new Error('questionCount must be an integer from 5 to 30.');
  }
  return numeric;
}

function normalizeQuizDraftRequest(body = {}, options = {}) {
  const chunkLimit = Number(options.chunkLimit) > 0 ? Number(options.chunkLimit) : 40;
  const chapter = body.chapter || body.metadata || {};
  const chunks = Array.isArray(body.sourceChunks)
    ? body.sourceChunks
    : Array.isArray(body.chunks)
      ? body.chunks
      : [];
  const questionCount = normalizeQuestionCount(body.questionCount || DEFAULT_QUIZ_QUESTION_COUNT);
  const difficultyCounts = body.difficultyCounts && typeof body.difficultyCounts === 'object'
    ? normalizeDifficultyCounts(body.difficultyCounts, questionCount)
    : buildDifficultyPlan(questionCount);

  const requiredChapterFields = ['schoolId', 'grade', 'subject', 'chapterNumber', 'chapterName'];
  for (const field of requiredChapterFields) {
    const value = chapter[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`chapter.${field} is required.`);
    }
  }

  const normalizedChunks = chunks
    .map((chunk, index) => normalizeSourceChunk(chunk, index))
    .filter(Boolean);
  const sourceChunks = evenlySample(normalizedChunks, chunkLimit);

  if (sourceChunks.length < 2) {
    throw new Error('At least two chapter context chunks are required for quiz generation.');
  }

  return {
    chapter: {
      schoolId: String(chapter.schoolId).trim(),
      board: cleanOptionalString(chapter.board),
      curriculum: cleanOptionalString(chapter.curriculum),
      grade: Number(chapter.grade),
      subject: String(chapter.subject).trim(),
      book: cleanOptionalString(chapter.book),
      chapterNumber: Number(chapter.chapterNumber),
      chapterName: String(chapter.chapterName).trim(),
      language: cleanOptionalString(chapter.language) || 'English',
      edition: cleanOptionalString(chapter.edition),
    },
    sourceChunks,
    questionCount,
    difficultyCounts,
    teacherId: cleanOptionalString(body.teacherId),
  };
}

function evenlySample(items, limit) {
  if (!Array.isArray(items) || !items.length || limit <= 0) return [];
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]];
  const lastIndex = items.length - 1;
  return Array.from({ length: limit }, (_unused, position) => (
    items[Math.round(position * lastIndex / (limit - 1))]
  ));
}

function normalizeDifficultyCounts(counts, questionCount) {
  const normalized = {};
  let total = 0;
  for (const [difficulty] of DIFFICULTY_WEIGHTS) {
    const value = Number(counts[difficulty] || 0);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`difficultyCounts.${difficulty} must be a non-negative integer.`);
    }
    normalized[difficulty] = value;
    total += value;
  }
  if (total !== questionCount) {
    throw new Error('difficultyCounts must add up to questionCount.');
  }
  return normalized;
}

function cleanOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSourceChunk(chunk, index) {
  const text = typeof chunk?.text === 'string' ? chunk.text.trim() : '';
  if (!text) return null;
  return {
    chunkId: String(chunk.chunkId || chunk.id || `chunk-${index + 1}`),
    text: text.slice(0, 1800),
    source: typeof chunk.source === 'string' ? chunk.source : '',
    section: cleanOptionalString(chunk.metadata?.section || chunk.section),
    entityType: cleanOptionalString(chunk.metadata?.entityType || chunk.entityType),
    pageStart: chunk.pageStart || chunk.metadata?.pageStart || null,
    pageEnd: chunk.pageEnd || chunk.metadata?.pageEnd || null,
  };
}

/**
 * Picks the LLM provider for quiz drafting. OpenRouter (an OpenAI-family model,
 * given strict json_schema structured outputs) wins when configured; Groq is a
 * fallback so quiz generation still works when only a Groq key is available, as
 * is the case whenever OPENROUTER_API_KEY hasn't been funded yet. Groq's
 * OpenAI-compatible models don't reliably support strict json_schema mode, so
 * that branch uses json_object mode plus an explicit schema in the prompt, and
 * leans on the existing validate-then-regenerate quality loop to catch drift.
 */
function resolveQuizProvider(config = {}) {
  const preferredProvider = String(config.llmProvider || process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (['local', 'vllm', 'openai-compatible'].includes(preferredProvider)) {
    const model = config.localModel || process.env.LOCAL_LLM_QUIZ_MODEL
      || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
    const strictSchema = String(
      config.localJsonSchema ?? process.env.LOCAL_LLM_JSON_SCHEMA ?? 'true'
    ).toLowerCase() !== 'false';
    return {
      name: 'local',
      envPrefix: 'LOCAL_LLM',
      apiKey: config.localApiKey ?? process.env.LOCAL_LLM_API_KEY ?? '',
      model,
      baseUrl: normalizeBaseUrl(config.localBaseUrl || process.env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_BASE_URL),
      extraHeaders: {},
      strictSchema,
      chunkLimit: 40,
      defaultQualityReview: true,
      defaultQualityAttempts: 2,
      buildRequestBody: (messages, { maxCompletionTokens }) => ({
        model,
        messages,
        response_format: strictSchema ? {
          type: 'json_schema',
          json_schema: {
            name: 'chapter_quiz_draft',
            description: 'A grounded, age-appropriate chapter quiz draft for teacher review.',
            strict: true,
            schema: quizDraftSchema,
          },
        } : { type: 'json_object' },
        max_tokens: maxCompletionTokens,
        temperature: 0.2,
      }),
    };
  }

  const openrouterApiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY;
  if (openrouterApiKey) {
    const model = config.model || process.env.OPENROUTER_QUIZ_MODEL || DEFAULT_OPENROUTER_QUIZ_MODEL;
    assertOpenRouterOpenAiModel(model);
    return {
      name: 'openrouter',
      apiKey: openrouterApiKey,
      model,
      baseUrl: normalizeBaseUrl(config.baseUrl || process.env.OPENROUTER_API_BASE_URL || DEFAULT_OPENROUTER_BASE_URL),
      extraHeaders: openRouterAttributionHeaders(config),
      strictSchema: true,
      chunkLimit: 40,
      defaultQualityReview: true,
      defaultQualityAttempts: 2,
      buildRequestBody: (messages, { reasoningEffort, maxCompletionTokens }) => ({
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'chapter_quiz_draft',
            description: 'A grounded, age-appropriate chapter quiz draft for teacher review.',
            strict: true,
            schema: quizDraftSchema,
          },
        },
        provider: { require_parameters: true },
        reasoning: { effort: reasoningEffort },
        max_completion_tokens: maxCompletionTokens,
      }),
    };
  }

  const groqApiKey = config.groqApiKey || process.env.GROQ_API_KEY;
  if (groqApiKey) {
    const model = config.model || process.env.GROQ_QUIZ_MODEL || DEFAULT_GROQ_QUIZ_MODEL;
    return {
      name: 'groq',
      apiKey: groqApiKey,
      model,
      baseUrl: normalizeBaseUrl(config.baseUrl || process.env.GROQ_API_BASE_URL || DEFAULT_GROQ_BASE_URL),
      extraHeaders: {},
      strictSchema: false,
      // Groq's free/on-demand tier caps this class of model at 12,000 tokens
      // per minute. A single quiz-draft call already uses ~8-9k of that budget,
      // so a second call in the same 60s window (the quality-review pass, or a
      // quality-gate retry) reliably blows the limit. Trade a smaller source
      // sample and a single pass for actually completing on the free tier.
      chunkLimit: 24,
      defaultQualityReview: false,
      defaultQualityAttempts: 1,
      defaultMaxCompletionTokens: 2400,
      buildRequestBody: (messages, { maxCompletionTokens }) => ({
        model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: maxCompletionTokens,
        temperature: 0.4,
        // See services/ai/structured-llm.js's buildGroq for why gpt-oss models
        // need reasoning_effort capped — otherwise the hidden reasoning trace
        // can consume the whole token budget and return empty content.
        ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
    };
  }

  throw new Error('Set LLM_PROVIDER=local or configure OPENROUTER_API_KEY/GROQ_API_KEY for quiz generation.');
}

function buildQuizJsonSchemaInstructions() {
  return [
    'Respond with a single JSON object only — no markdown, no code fences, no commentary before or after it.',
    'The JSON object must conform exactly to this JSON Schema:',
    JSON.stringify(quizDraftSchema),
  ].join('\n');
}

function parseQuizDraftJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function generateQuizDraft({ payload, config = {}, fetchFn = fetch }) {
  const provider = resolveQuizProvider(config);
  const normalized = normalizeQuizDraftRequest(payload, { chunkLimit: provider.chunkLimit });

  // Each provider reads its own env prefix so a Groq fallback never inherits
  // OpenRouter's tuned-for-a-bigger-budget knobs (OPENROUTER_QUIZ_* is set in
  // .env even when only GROQ_API_KEY is configured).
  const envPrefix = provider.envPrefix || (provider.name === 'groq' ? 'GROQ' : 'OPENROUTER');
  const reasoningEffort = config.reasoningEffort || process.env[`${envPrefix}_QUIZ_REASONING_EFFORT`] || 'medium';
  const timeoutMs = Number(config.timeoutMs || process.env[`${envPrefix}_QUIZ_TIMEOUT_MS`] || 60000);
  const maxCompletionTokens = Number(
    config.maxCompletionTokens || process.env[`${envPrefix}_QUIZ_MAX_COMPLETION_TOKENS`] || provider.defaultMaxCompletionTokens || 4200
  );
  const maxQualityAttempts = normalizeQualityAttempts(
    config.maxQualityAttempts || process.env[`${envPrefix}_QUIZ_QUALITY_ATTEMPTS`] || provider.defaultQualityAttempts || 2
  );
  const qualityReviewEnvValue = process.env[`${envPrefix}_QUIZ_QUALITY_REVIEW`];
  const qualityReviewEnabled = config.qualityReview !== undefined
    ? config.qualityReview !== false
    : qualityReviewEnvValue !== undefined
      ? String(qualityReviewEnvValue).toLowerCase() !== 'false'
      : provider.defaultQualityReview !== false;
  let rejectionReason = '';

  const requestCompletion = async messages => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${provider.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
        method: 'POST',
        headers: {
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...provider.extraHeaders,
        },
        body: JSON.stringify(provider.buildRequestBody(messages, { reasoningEffort, maxCompletionTokens })),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`${provider.name} quiz generation failed with ${response.status}: ${errorBody}`);
      }
      const raw = await response.json();
      const text = extractResponseText(raw);
      if (!text) throw new Error(`${provider.name} quiz generation returned no output text.`);
      return { raw, text };
    } finally {
      clearTimeout(timeout);
    }
  };

  const systemPrompt = provider.strictSchema
    ? buildQuizSystemPrompt()
    : `${buildQuizSystemPrompt()}\n\n${buildQuizJsonSchemaInstructions()}`;

  for (let attempt = 1; attempt <= maxQualityAttempts; attempt += 1) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildQuizUserPrompt(normalized) },
    ];
    if (rejectionReason) {
      messages.push({
        role: 'user',
        content: [
          'Your previous draft was rejected by the automatic assessment-quality gate.',
          `Rejection reason: ${rejectionReason}`,
          'Regenerate the entire quiz with different questions.',
          'Do not ask about headings, titles, section/page/figure numbers, document order, exact textbook wording, or where content appears.',
          'Every replacement must directly assess a science concept, process, application, or cause-and-effect relationship.',
        ].join('\n'),
      });
    }

    const generated = await requestCompletion(messages);
    try {
      const draft = repairQuizDraftCitations(parseQuizDraftJson(generated.text), normalized);
      validateQuizDraft(draft, normalized);

      if (qualityReviewEnabled) {
        const review = await requestCompletion([
          ...messages,
          { role: 'assistant', content: JSON.stringify(draft) },
          { role: 'user', content: buildQuizReviewPrompt() },
        ]);
        const reviewedDraft = repairQuizDraftCitations(parseQuizDraftJson(review.text), normalized);
        validateQuizDraft(reviewedDraft, normalized);
        return {
          draft: reviewedDraft,
          model: review.raw.model || generated.raw.model || provider.model,
          provider: provider.name,
          usage: review.raw.usage || generated.raw.usage || null,
          difficultyCounts: normalized.difficultyCounts,
          qualityAttempts: attempt,
          qualityReviewed: true,
        };
      }

      return {
        draft,
        model: generated.raw.model || provider.model,
        provider: provider.name,
        usage: generated.raw.usage || null,
        difficultyCounts: normalized.difficultyCounts,
        qualityAttempts: attempt,
        qualityReviewed: false,
      };
    } catch (error) {
      rejectionReason = error.message || 'The draft did not meet assessment-quality rules.';
      if (attempt === maxQualityAttempts) {
        throw new Error(`Quiz draft failed quality validation after ${attempt} attempts: ${rejectionReason}`);
      }
    }
  }

  throw new Error('Quiz draft generation exhausted all quality attempts.');
}

function buildQuizReviewPrompt() {
  return [
    'Act as the final assessment editor. Return the complete revised quiz JSON, not comments.',
    'Replace any question that tests textbook layout, exact wording, headings, sections, page order, or trivial details.',
    'Check every MCQ distractor individually. A distractor is acceptable only if a learner with a realistic misconception about the same concept might choose it.',
    'Replace joke, absurd, unrelated, obviously impossible, or grammatically mismatched options.',
    'Keep all four MCQ options in the same conceptual category and at a similar level of detail.',
    'Make medium questions require application or explanation and hard questions require multi-step cause-and-effect reasoning.',
    'Ensure every question is self-contained, scientifically grounded in the supplied chapter context, and useful for diagnosing understanding.',
    'Preserve the exact question count and simple/medium/hard distribution.',
  ].join('\n');
}

function normalizeQualityAttempts(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 3) {
    throw new Error('QUIZ_QUALITY_ATTEMPTS must be an integer from 1 to 3.');
  }
  return numeric;
}

function assertOpenRouterOpenAiModel(model) {
  const value = String(model || '').trim();
  if (!value.startsWith('openai/') && !value.startsWith('~openai/')) {
    throw new Error('OPENROUTER_QUIZ_MODEL must be an OpenRouter OpenAI-family model slug such as openai/gpt-5-mini.');
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_OPENROUTER_BASE_URL).trim().replace(/\/+$/, '');
}

function openRouterAttributionHeaders(config = {}) {
  const headers = {};
  const referer = config.siteUrl || process.env.OPENROUTER_SITE_URL;
  const title = config.appName || process.env.OPENROUTER_APP_NAME || 'Roognis';
  if (referer) headers['HTTP-Referer'] = referer;
  if (title) headers['X-OpenRouter-Title'] = title;
  return headers;
}

function buildQuizSystemPrompt() {
  return [
    'You are Roognis, a careful school assessment designer.',
    'Create curriculum-grounded chapter quizzes for teacher review.',
    'Use only the provided chapter context for factual claims.',
    'Make questions age-appropriate for the grade, clear, unambiguous, and academically useful.',
    'Simple questions should test recall and direct understanding.',
    'Medium questions should require applying, comparing, or explaining ideas.',
    'Hard questions should require real thinking for the grade: multi-step reasoning, analysis, or transfer to a new but familiar situation.',
    'Assess science understanding, not the layout or wording of the textbook.',
    'Never ask for a heading, title, section number, page number, figure/table number, exact sentence, or where information appears.',
    'Every question must be self-contained and answerable without seeing the source page, an omitted diagram, or an earlier question.',
    'Avoid trivia, trick wording, duplicate questions, unsupported facts, and answer choices that are obviously wrong.',
    'MCQ distractors must be plausible misconceptions, grammatically parallel, and similar in specificity to the correct answer.',
    'Do not use joke answers, absurd distractors, or all/none-of-the-above options.',
    'Keep every answer explanation useful but compact: one sentence, maximum 14 words.',
  ].join('\n');
}

function buildQuizUserPrompt(request) {
  const { chapter, difficultyCounts, questionCount } = request;
  const context = request.sourceChunks.map((chunk, index) => {
    const meta = [
      chunk.section ? `section=${chunk.section}` : null,
      chunk.entityType ? `type=${chunk.entityType}` : null,
      chunk.pageStart ? `page=${chunk.pageStart}` : null,
    ].filter(Boolean).join(', ');
    return [
      `SOURCE ${index + 1}`,
      `chunkId: ${chunk.chunkId}`,
      meta ? `metadata: ${meta}` : null,
      `source: ${chunk.source || 'chapter PDF'}`,
      `text: ${chunk.text}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    `Chapter metadata: ${JSON.stringify(chapter)}`,
    `Create exactly ${questionCount} questions.`,
    `Difficulty counts must be exactly: simple=${difficultyCounts.simple}, medium=${difficultyCounts.medium}, hard=${difficultyCounts.hard}.`,
    'Use a healthy mix of MCQ and short-answer questions. MCQs must have exactly four options and the correctAnswer must exactly match one option. Short-answer questions must have an empty options array.',
    'Cover the full chapter: definitions, core concepts, processes, activities/examples, applications, diagrams/tables when present, and exercises/key points.',
    'Prefer concept-level coverage over page-order repetition.',
    'Ignore chunks that contain only headings, page furniture, exercise numbering, captions, or document-navigation text.',
    'Simple questions must still test a science fact or concept; never test whether a learner remembers the document structure.',
    'For medium and hard questions, use familiar real-life situations and require explanation, prediction, comparison, or cause-and-effect reasoning.',
    'If a diagram or table is not reproduced inside the question, do not refer to it.',
    'Use grade-level language and thinking depth.',
    'Set weakAreaLabel to the smallest useful remediation topic a teacher could act on.',
    'Keep chapterSummary under 20 words, coverage to exactly 5 concepts, and concept/weak-area labels under 5 words.',
    'Return only the structured JSON.',
    '',
    'Chapter context:',
    context,
  ].join('\n');
}

function extractResponseText(response) {
  const choiceContent = response?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return choiceContent;
  if (Array.isArray(choiceContent)) {
    return choiceContent
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('');
  }

  if (typeof response?.output_text === 'string') return response.output_text;
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const contentItem of content) {
      if (contentItem?.type === 'output_text' && typeof contentItem.text === 'string') {
        parts.push(contentItem.text);
      }
    }
  }
  return parts.join('');
}

function repairQuizDraftCitations(draft, request) {
  if (!draft || typeof draft !== 'object') return draft;
  const validChunkIds = new Set(request.sourceChunks.map(chunk => chunk.chunkId));
  const fallbackChunkId = request.sourceChunks[0]?.chunkId;
  if (!fallbackChunkId) return draft;

  if (Array.isArray(draft.coverage)) {
    draft.coverage.forEach(item => {
      if (!item || typeof item !== 'object') return;
      item.sourceChunkIds = cleanSourceChunkIds(item.sourceChunkIds, validChunkIds);
      if (!item.sourceChunkIds.length) {
        item.sourceChunkIds = [bestMatchingChunkId(item.concept, request) || fallbackChunkId];
      }
    });
  }

  if (Array.isArray(draft.questions)) {
    draft.questions.forEach(question => {
      if (!question || typeof question !== 'object') return;
      question.sourceChunkIds = cleanSourceChunkIds(question.sourceChunkIds, validChunkIds);
      if (!question.sourceChunkIds.length) {
        question.sourceChunkIds = [
          bestMatchingChunkId([
            question.conceptTag,
            question.weakAreaLabel,
            question.prompt,
            question.correctAnswer,
            question.explanation,
          ].filter(Boolean).join(' '), request) || fallbackChunkId,
        ];
      }
    });
  }

  return draft;
}

function cleanSourceChunkIds(sourceChunkIds, validChunkIds) {
  if (!Array.isArray(sourceChunkIds)) return [];
  const cleaned = [];
  for (const chunkId of sourceChunkIds) {
    const value = String(chunkId || '').trim();
    if (!value || !validChunkIds.has(value) || cleaned.includes(value)) continue;
    cleaned.push(value);
    if (cleaned.length >= 3) break;
  }
  return cleaned;
}

function bestMatchingChunkId(query, request) {
  const queryTokens = tokenizeForCitationMatch(query);
  if (!queryTokens.length) return null;

  let bestChunk = null;
  let bestScore = 0;
  for (const chunk of request.sourceChunks) {
    const chunkTokens = tokenizeForCitationMatch([
      chunk.section,
      chunk.entityType,
      chunk.source,
      chunk.text,
    ].filter(Boolean).join(' '));
    const chunkTokenSet = new Set(chunkTokens);
    const score = queryTokens.reduce((sum, token) => sum + (chunkTokenSet.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestChunk = chunk;
    }
  }

  return bestChunk?.chunkId || null;
}

function tokenizeForCitationMatch(value) {
  const stopWords = new Set([
    'about',
    'after',
    'also',
    'answer',
    'because',
    'chapter',
    'correct',
    'does',
    'from',
    'have',
    'into',
    'that',
    'their',
    'this',
    'what',
    'when',
    'where',
    'which',
    'with',
    'would',
  ]);
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !stopWords.has(token));
}

function validateQuizDraft(draft, request) {
  if (!draft || typeof draft !== 'object') throw new Error('Quiz draft must be an object.');
  if (!Array.isArray(draft.questions)) throw new Error('Quiz draft questions must be an array.');
  if (draft.questions.length !== request.questionCount) {
    throw new Error(`Quiz draft must contain exactly ${request.questionCount} questions.`);
  }

  const validChunkIds = new Set(request.sourceChunks.map(chunk => chunk.chunkId));
  const seenPrompts = new Set();
  const counts = { simple: 0, medium: 0, hard: 0 };

  draft.questions.forEach((question, index) => {
    const prefix = `questions[${index}]`;
    if (!question || typeof question !== 'object') throw new Error(`${prefix} must be an object.`);
    if (!['mcq', 'short_answer'].includes(question.type)) throw new Error(`${prefix}.type is invalid.`);
    if (!Object.prototype.hasOwnProperty.call(counts, question.difficulty)) {
      throw new Error(`${prefix}.difficulty is invalid.`);
    }
    counts[question.difficulty] += 1;

    const promptKey = normalizeForDuplicateCheck(question.prompt);
    if (!promptKey || promptKey.length < 12) throw new Error(`${prefix}.prompt is too short.`);
    if (seenPrompts.has(promptKey)) throw new Error(`${prefix}.prompt duplicates another question.`);
    seenPrompts.add(promptKey);
    validateQuestionQuality(question, prefix);

    if (!question.conceptTag || !question.weakAreaLabel) {
      throw new Error(`${prefix} must include conceptTag and weakAreaLabel.`);
    }
    if (!question.correctAnswer || !question.explanation) {
      throw new Error(`${prefix} must include correctAnswer and explanation.`);
    }
    if (!Array.isArray(question.sourceChunkIds) || !question.sourceChunkIds.length) {
      throw new Error(`${prefix}.sourceChunkIds must include at least one chunk id.`);
    }
    for (const chunkId of question.sourceChunkIds) {
      if (!validChunkIds.has(chunkId)) throw new Error(`${prefix}.sourceChunkIds contains an unknown chunk id.`);
    }

    if (question.type === 'mcq') {
      if (!Array.isArray(question.options) || question.options.length !== 4) {
        throw new Error(`${prefix}.options must contain exactly four options for MCQ.`);
      }
      const normalizedOptions = question.options.map(normalizeForDuplicateCheck);
      if (normalizedOptions.some(option => !option)) {
        throw new Error(`${prefix}.options must not be empty.`);
      }
      if (new Set(normalizedOptions).size !== normalizedOptions.length) {
        throw new Error(`${prefix}.options must be distinct.`);
      }
      if (question.options.some(option => WEAK_MCQ_OPTION_PATTERNS.some(pattern => pattern.test(String(option).trim())))) {
        throw new Error(`${prefix}.options must use plausible content-based distractors.`);
      }
      if (!question.options.includes(question.correctAnswer)) {
        throw new Error(`${prefix}.correctAnswer must exactly match one MCQ option.`);
      }
    } else if (Array.isArray(question.options) && question.options.length > 0) {
      throw new Error(`${prefix}.options must be empty for short-answer questions.`);
    }
  });

  for (const [difficulty, expected] of Object.entries(request.difficultyCounts)) {
    if (counts[difficulty] !== expected) {
      throw new Error(`Expected ${expected} ${difficulty} questions but got ${counts[difficulty]}.`);
    }
  }

  return true;
}

function validateQuestionQuality(question, prefix = 'question') {
  const prompt = String(question?.prompt || '').trim();
  const metaText = [question?.conceptTag, question?.weakAreaLabel]
    .filter(Boolean)
    .join(' ');

  if (NAVIGATION_TRIVIA_PATTERNS.some(pattern => pattern.test(prompt))) {
    throw new Error(`${prefix}.prompt tests document navigation instead of subject understanding.`);
  }
  if (/\b(?:heading recall|section heading|document structure|page location)\b/i.test(metaText)) {
    throw new Error(`${prefix} uses a document-navigation concept label.`);
  }
  return true;
}

function normalizeForDuplicateCheck(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = {
  DEFAULT_QUIZ_QUESTION_COUNT,
  quizDraftSchema,
  buildDifficultyPlan,
  evenlySample,
  normalizeQuizDraftRequest,
  generateQuizDraft,
  resolveQuizProvider,
  assertOpenRouterOpenAiModel,
  buildQuizSystemPrompt,
  buildQuizUserPrompt,
  extractResponseText,
  repairQuizDraftCitations,
  validateQuestionQuality,
  validateQuizDraft,
};
