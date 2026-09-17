const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDifficultyPlan,
  evenlySample,
  normalizeQuizDraftRequest,
  generateQuizDraft,
  resolveQuizProvider,
  assertOpenRouterOpenAiModel,
  extractResponseText,
  repairQuizDraftCitations,
  validateQuestionQuality,
  validateQuizDraft,
} = require('../quiz-draft');

function sampleRequest() {
  return normalizeQuizDraftRequest({
    chapter: {
      schoolId: '22222222-2222-2222-2222-222222222222',
      board: 'CBSE',
      curriculum: 'NCERT',
      grade: 6,
      subject: 'Science',
      book: 'Curiosity',
      chapterNumber: 1,
      chapterName: 'Plants and nutrition',
      language: 'English',
      edition: '2026-27',
    },
    questionCount: 5,
    sourceChunks: [
      { chunkId: 'chunk-a', text: 'Plants make food by photosynthesis.', source: 'Chapter 1' },
      { chunkId: 'chunk-b', text: 'Roots absorb water and minerals from soil.', source: 'Chapter 1' },
      { chunkId: 'chunk-c', text: 'Leaves have stomata for gas exchange.', source: 'Chapter 1' },
    ],
  });
}

function sampleDraft() {
  return {
    title: 'Plants and nutrition quiz',
    chapterSummary: 'A quiz covering plant food-making, roots, and leaves.',
    coverage: [
      { concept: 'Photosynthesis', sourceChunkIds: ['chunk-a'] },
      { concept: 'Roots', sourceChunkIds: ['chunk-b'] },
      { concept: 'Stomata', sourceChunkIds: ['chunk-c'] },
    ],
    questions: [
      question(1, 'simple', 'remember', 'What process helps green plants make food?', ['chunk-a']),
      question(2, 'simple', 'understand', 'Which plant part absorbs water and minerals?', ['chunk-b']),
      question(3, 'simple', 'understand', 'What are stomata used for in leaves?', ['chunk-c']),
      question(4, 'medium', 'apply', 'Why would a plant wilt if its roots are damaged?', ['chunk-b']),
      question(5, 'hard', 'analyze', 'A plant is kept in darkness for two days. What should happen to food-making and why?', ['chunk-a']),
    ],
  };
}

function question(order, difficulty, bloomLevel, prompt, sourceChunkIds) {
  return {
    order,
    type: 'short_answer',
    difficulty,
    bloomLevel,
    conceptTag: prompt.split(' ').slice(0, 3).join(' '),
    weakAreaLabel: 'Chapter concept',
    prompt,
    options: [],
    correctAnswer: 'A concise correct answer.',
    explanation: 'The answer follows from the provided chapter context.',
    sourceChunkIds,
    marks: difficulty === 'hard' ? 3 : 1,
  };
}

test('builds deterministic 50/30/20 difficulty counts', () => {
  assert.deepEqual(buildDifficultyPlan(10), { simple: 5, medium: 3, hard: 2 });
  assert.deepEqual(buildDifficultyPlan(5), { simple: 3, medium: 1, hard: 1 });
  assert.deepEqual(buildDifficultyPlan(7), { simple: 4, medium: 2, hard: 1 });
});

test('normalizes quiz draft request and source chunks', () => {
  const request = sampleRequest();

  assert.equal(request.questionCount, 5);
  assert.deepEqual(request.difficultyCounts, { simple: 3, medium: 1, hard: 1 });
  assert.equal(request.sourceChunks.length, 3);
  assert.equal(request.chapter.grade, 6);
});

test('samples long chapter context across the beginning, middle, and end', () => {
  const items = Array.from({ length: 100 }, (_unused, index) => index);
  const sampled = evenlySample(items, 5);
  assert.deepEqual(sampled, [0, 25, 50, 74, 99]);
});

test('validates a grounded quiz draft with exact difficulty distribution', () => {
  assert.equal(validateQuizDraft(sampleDraft(), sampleRequest()), true);
});

test('rejects duplicate prompts and unknown source chunks', () => {
  const request = sampleRequest();
  const duplicate = sampleDraft();
  duplicate.questions[1].prompt = duplicate.questions[0].prompt;

  assert.throws(() => validateQuizDraft(duplicate, request), /duplicates/);

  const unknownChunk = sampleDraft();
  unknownChunk.questions[0].sourceChunkIds = ['missing'];
  assert.throws(() => validateQuizDraft(unknownChunk, request), /unknown chunk/);
});

test('rejects textbook-navigation trivia instead of science understanding', () => {
  const badPrompts = [
    'Write the heading used for section 1.1 in this chapter.',
    'What is the title shown on page 4?',
    'According to this chapter, which section comes after crop preparation?',
    'Identify Figure 1.2 from the textbook.',
  ];

  for (const prompt of badPrompts) {
    assert.throws(
      () => validateQuestionQuality({ prompt, conceptTag: 'Agriculture', weakAreaLabel: 'Crop practices' }),
      /document navigation/
    );
  }
  assert.equal(validateQuestionQuality({
    prompt: 'Why should a farmer loosen soil before sowing seeds?',
    conceptTag: 'Soil preparation',
    weakAreaLabel: 'Tilling purpose',
  }), true);
});

test('rejects duplicate and all-of-the-above MCQ options', () => {
  const request = sampleRequest();
  const duplicateOptions = sampleDraft();
  duplicateOptions.questions[0] = {
    ...duplicateOptions.questions[0],
    type: 'mcq',
    options: ['Photosynthesis', 'Respiration', 'Respiration', 'Transpiration'],
    correctAnswer: 'Photosynthesis',
  };
  assert.throws(() => validateQuizDraft(duplicateOptions, request), /distinct/);

  const weakOptions = sampleDraft();
  weakOptions.questions[0] = {
    ...weakOptions.questions[0],
    type: 'mcq',
    options: ['Photosynthesis', 'Respiration', 'Transpiration', 'All of the above'],
    correctAnswer: 'Photosynthesis',
  };
  assert.throws(() => validateQuizDraft(weakOptions, request), /plausible content-based distractors/);
});

test('repairs unknown source citations with valid chapter chunks', () => {
  const request = sampleRequest();
  const draft = sampleDraft();
  draft.coverage[0].sourceChunkIds = ['missing-coverage'];
  draft.questions[0].sourceChunkIds = ['missing-question'];

  const repaired = repairQuizDraftCitations(draft, request);

  assert.deepEqual(repaired.coverage[0].sourceChunkIds, ['chunk-a']);
  assert.deepEqual(repaired.questions[0].sourceChunkIds, ['chunk-a']);
  assert.equal(validateQuizDraft(repaired, request), true);
});

test('accepts only OpenRouter OpenAI-family quiz models', () => {
  assert.doesNotThrow(() => assertOpenRouterOpenAiModel('openai/gpt-5-mini'));
  assert.doesNotThrow(() => assertOpenRouterOpenAiModel('~openai/gpt-latest'));
  assert.throws(() => assertOpenRouterOpenAiModel('anthropic/claude-sonnet-4.5'), /OpenAI-family/);
});

test('extracts OpenRouter chat completion output text', () => {
  const output = extractResponseText({
    choices: [
      {
        message: {
          content: '{"ok":true}',
        },
      },
    ],
  });

  assert.equal(output, '{"ok":true}');
});

test('resolves keyless local vLLM quiz generation with strict JSON Schema', () => {
  const provider = resolveQuizProvider({
    llmProvider: 'local',
    localBaseUrl: 'http://model-server:8000/v1/',
    localModel: 'org/local-instruct',
  });
  const body = provider.buildRequestBody([], { maxCompletionTokens: 3000 });

  assert.equal(provider.name, 'local');
  assert.equal(provider.baseUrl, 'http://model-server:8000/v1');
  assert.equal(provider.model, 'org/local-instruct');
  assert.equal(provider.apiKey, '');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.max_tokens, 3000);
});

test('sends a keyless local quiz request without an Authorization header', async () => {
  let capturedRequest;
  const result = await generateQuizDraft({
    payload: sampleRequest(),
    config: {
      llmProvider: 'local',
      localBaseUrl: 'http://model-server:8000/v1',
      localModel: 'org/local-instruct',
      qualityReview: false,
      timeoutMs: 1000,
    },
    fetchFn: async (_url, options) => {
      capturedRequest = options;
      return {
        ok: true,
        json: async () => ({ model: 'org/local-instruct', choices: [{ message: { content: JSON.stringify(sampleDraft()) } }] }),
      };
    },
  });
  assert.equal(capturedRequest.headers.Authorization, undefined);
  assert.equal(result.provider, 'local');
});

test('keeps compatibility with Responses-style output text extraction', () => {
  const output = extractResponseText({
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: '{"ok":true}' },
        ],
      },
    ],
  });

  assert.equal(output, '{"ok":true}');
});

test('sends OpenRouter structured-output request with OpenAI model slug', async () => {
  const request = sampleRequest();
  const draft = JSON.stringify(sampleDraft());
  let capturedUrl = '';
  let capturedRequest = null;

  const result = await generateQuizDraft({
    payload: request,
    config: {
      openrouterApiKey: 'test-openrouter-key',
      model: 'openai/gpt-5-mini',
      reasoningEffort: 'high',
      timeoutMs: 1000,
      maxCompletionTokens: 4000,
      qualityReview: false,
      siteUrl: 'https://example.test',
      appName: 'Roognis Tests',
    },
    fetchFn: async (url, options) => {
      capturedUrl = url;
      capturedRequest = {
        headers: options.headers,
        body: JSON.parse(options.body),
      };
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-5-mini',
          choices: [{ message: { content: draft } }],
          usage: { total_tokens: 123 },
        }),
      };
    },
  });

  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(capturedRequest.headers.Authorization, 'Bearer test-openrouter-key');
  assert.equal(capturedRequest.headers['HTTP-Referer'], 'https://example.test');
  assert.equal(capturedRequest.headers['X-OpenRouter-Title'], 'Roognis Tests');
  assert.equal(capturedRequest.body.model, 'openai/gpt-5-mini');
  assert.equal(capturedRequest.body.provider.require_parameters, true);
  assert.equal(capturedRequest.body.response_format.type, 'json_schema');
  assert.equal(capturedRequest.body.response_format.json_schema.strict, true);
  assert.equal(capturedRequest.body.reasoning.effort, 'high');
  assert.equal(capturedRequest.body.max_completion_tokens, 4000);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedRequest.body, 'temperature'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedRequest.body, 'metadata'), false);
  assert.equal(result.model, 'openai/gpt-5-mini');
  assert.equal(result.usage.total_tokens, 123);
  assert.equal(result.qualityAttempts, 1);
});

test('regenerates the whole quiz after the quality gate rejects navigation trivia', async () => {
  const badDraft = sampleDraft();
  badDraft.questions[0].prompt = 'Write the heading used for section 1.1 in this chapter.';
  let calls = 0;
  const capturedMessages = [];

  const result = await generateQuizDraft({
    payload: sampleRequest(),
    config: {
      openrouterApiKey: 'test-openrouter-key',
      model: 'openai/gpt-5-mini',
      timeoutMs: 1000,
      maxQualityAttempts: 2,
      qualityReview: false,
    },
    fetchFn: async (_url, options) => {
      calls += 1;
      capturedMessages.push(JSON.parse(options.body).messages);
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-5-mini',
          choices: [{ message: { content: JSON.stringify(calls === 1 ? badDraft : sampleDraft()) } }],
        }),
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.qualityAttempts, 2);
  assert.match(capturedMessages[1][2].content, /previous draft was rejected/i);
  assert.match(capturedMessages[1][2].content, /document navigation/i);
});

test('prefers OpenRouter over Groq when both keys are present', () => {
  const provider = resolveQuizProvider({ openrouterApiKey: 'or-key', groqApiKey: 'groq-key', model: 'openai/gpt-5-mini' });
  assert.equal(provider.name, 'openrouter');
  assert.equal(provider.model, 'openai/gpt-5-mini');
});

test('falls back to Groq when no OpenRouter key is configured', () => {
  const provider = resolveQuizProvider({ groqApiKey: 'groq-key' });
  assert.equal(provider.name, 'groq');
  assert.equal(provider.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(provider.strictSchema, false);
});

test('throws a clear error when neither provider key is configured', () => {
  assert.throws(() => resolveQuizProvider({}), /LLM_PROVIDER=local.*OPENROUTER_API_KEY\/GROQ_API_KEY/);
});

test('generates a quiz draft over the Groq fallback with json_object mode', async () => {
  const draft = JSON.stringify(sampleDraft());
  let capturedUrl = '';
  let capturedBody = null;

  const result = await generateQuizDraft({
    payload: sampleRequest(),
    config: {
      groqApiKey: 'test-groq-key',
      model: 'openai/gpt-oss-120b',
      timeoutMs: 1000,
      qualityReview: false,
    },
    fetchFn: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: draft } }],
          usage: { total_tokens: 88 },
        }),
      };
    },
  });

  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(capturedBody.model, 'openai/gpt-oss-120b');
  assert.equal(capturedBody.response_format.type, 'json_object');
  assert.equal(capturedBody.reasoning_effort, 'low');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, 'reasoning'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, 'provider'), false);
  assert.match(capturedBody.messages[0].content, /JSON Schema/);
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'openai/gpt-oss-120b');
  assert.equal(result.usage.total_tokens, 88);
});

test('parses fenced JSON from a Groq response that ignores the no-markdown instruction', async () => {
  const draft = sampleDraft();
  const fenced = '```json\n' + JSON.stringify(draft) + '\n```';

  const result = await generateQuizDraft({
    payload: sampleRequest(),
    config: {
      groqApiKey: 'test-groq-key',
      timeoutMs: 1000,
      qualityReview: false,
    },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        model: 'openai/gpt-oss-120b',
        choices: [{ message: { content: fenced } }],
      }),
    }),
  });

  assert.equal(result.draft.title, draft.title);
});

test('caps Groq to a smaller chunk sample and a single quality pass by default', () => {
  const provider = resolveQuizProvider({ groqApiKey: 'groq-key' });
  assert.ok(provider.chunkLimit < 40);
  assert.equal(provider.defaultQualityReview, false);
  assert.equal(provider.defaultQualityAttempts, 1);
});

test('does not run a second Groq quality-review pass unless explicitly requested', async () => {
  let calls = 0;
  await generateQuizDraft({
    payload: sampleRequest(),
    config: { groqApiKey: 'test-groq-key', timeoutMs: 1000 },
    fetchFn: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: JSON.stringify(sampleDraft()) } }],
        }),
      };
    },
  });
  assert.equal(calls, 1);
});

test('throws immediately when no quiz provider key is configured at all', async () => {
  await assert.rejects(
    generateQuizDraft({ payload: sampleRequest(), config: {} }),
    /LLM_PROVIDER=local.*OPENROUTER_API_KEY\/GROQ_API_KEY/
  );
});

test('runs a final assessment-editor pass for semantically stronger questions', async () => {
  const firstDraft = sampleDraft();
  firstDraft.questions[0] = {
    ...firstDraft.questions[0],
    type: 'mcq',
    options: ['Photosynthesis', 'A microscope', 'Sleeping', 'Changing colour'],
    correctAnswer: 'Photosynthesis',
  };
  let calls = 0;
  const capturedMessages = [];

  const result = await generateQuizDraft({
    payload: sampleRequest(),
    config: {
      openrouterApiKey: 'test-openrouter-key',
      model: 'openai/gpt-5-mini',
      timeoutMs: 1000,
      maxQualityAttempts: 2,
    },
    fetchFn: async (_url, options) => {
      calls += 1;
      capturedMessages.push(JSON.parse(options.body).messages);
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-5-mini',
          choices: [{ message: { content: JSON.stringify(calls === 1 ? firstDraft : sampleDraft()) } }],
        }),
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.qualityReviewed, true);
  assert.match(capturedMessages[1][3].content, /realistic misconception/i);
  assert.equal(result.draft.questions[0].type, 'short_answer');
});
