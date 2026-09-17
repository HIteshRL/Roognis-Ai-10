const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveStructuredProvider,
  generateStructured,
  parseJsonPayload,
  extractStructuredText,
  buildJsonSchemaInstructions,
} = require('../structured-llm');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

/** Env is process-global; snapshot and restore so tests cannot leak into each other. */
const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GROQ_MODEL', 'LLM_PROVIDER',
  'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_API_KEY', 'LOCAL_LLM_JSON_SCHEMA',
  'LOCAL_LLM_DEMO_MODEL', 'LOCAL_LLM_DEMO_ATTEMPTS',
  'OPENROUTER_DEMO_MODEL', 'GROQ_DEMO_MODEL',
  'OPENROUTER_DEMO_ATTEMPTS', 'GROQ_DEMO_ATTEMPTS',
  'OPENROUTER_DEMO_MAX_COMPLETION_TOKENS', 'GROQ_DEMO_MAX_COMPLETION_TOKENS',
  'OPENROUTER_SITE_URL', 'OPENROUTER_APP_NAME',
];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A fetch stub that returns each queued body in turn and records every request. */
function stubFetch(payloads) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const payload = payloads[Math.min(calls.length - 1, payloads.length - 1)];
    return {
      ok: true,
      json: async () => ({ model: 'stub-model', usage: { total_tokens: 1 }, choices: [{ message: { content: payload } }] }),
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe('provider resolution', () => {
  it('prefers OpenRouter and uses strict json_schema', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.GROQ_API_KEY = 'groq-key';
    const provider = resolveStructuredProvider({ task: 'demo' });

    assert.equal(provider.name, 'openrouter');
    assert.equal(provider.strictSchema, true);
    const body = provider.buildRequestBody([], { schema: SCHEMA, schemaName: 'demo', maxCompletionTokens: 100 });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.require_parameters, true, 'must not route to an upstream that ignores the schema');
  });

  it('falls back to Groq in json_object mode', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    const provider = resolveStructuredProvider({ task: 'demo' });

    assert.equal(provider.name, 'groq');
    assert.equal(provider.strictSchema, false);
    const body = provider.buildRequestBody([], { schema: SCHEMA, schemaName: 'demo', maxCompletionTokens: 100 });
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_tokens, 100, 'Groq uses max_tokens, not max_completion_tokens');
  });

  it('derives env knob names from the task', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_MODEL = 'llama-custom';
    assert.equal(resolveStructuredProvider({ task: 'demo' }).model, 'llama-custom');
  });

  it('rejects a non-OpenAI OpenRouter model', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_DEMO_MODEL = 'anthropic/claude';
    assert.throws(() => resolveStructuredProvider({ task: 'demo' }), /OpenAI-family/);
  });

  it('honours LLM_PROVIDER=groq even when an OpenRouter key is also set', () => {
    // Regression: a real observed production config (LLM_PROVIDER=groq, a
    // valid GROQ_API_KEY, and a stale/exhausted OPENROUTER_API_KEY) used to
    // always pick OpenRouter anyway, since selection was key-presence-only.
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.LLM_PROVIDER = 'groq';
    assert.equal(resolveStructuredProvider({ task: 'demo' }).name, 'groq');
  });

  it('honours LLM_PROVIDER=openrouter explicitly', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.LLM_PROVIDER = 'openrouter';
    assert.equal(resolveStructuredProvider({ task: 'demo' }).name, 'openrouter');
  });

  it('uses a keyless local OpenAI-compatible provider when explicitly selected', () => {
    process.env.LLM_PROVIDER = 'local';
    process.env.LOCAL_LLM_BASE_URL = 'http://model-server:8000/v1/';
    process.env.LOCAL_LLM_MODEL = 'org/local-instruct';
    const provider = resolveStructuredProvider({ task: 'demo' });

    assert.equal(provider.name, 'local');
    assert.equal(provider.baseUrl, 'http://model-server:8000/v1');
    assert.equal(provider.model, 'org/local-instruct');
    assert.equal(provider.apiKey, '');
    assert.equal(provider.strictSchema, true);
    const body = provider.buildRequestBody([], {
      schema: SCHEMA, schemaName: 'demo', schemaDescription: '', maxCompletionTokens: 100,
    });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.max_tokens, 100);
  });

  it('can fall back to json_object for local servers without JSON Schema support', () => {
    process.env.LLM_PROVIDER = 'vllm';
    process.env.LOCAL_LLM_JSON_SCHEMA = 'false';
    const provider = resolveStructuredProvider({ task: 'demo' });
    const body = provider.buildRequestBody([], {
      schema: SCHEMA, schemaName: 'demo', schemaDescription: '', maxCompletionTokens: 100,
    });
    assert.equal(provider.strictSchema, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  it('falls back to key-presence selection when the preferred provider has no key', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.LLM_PROVIDER = 'groq';
    assert.equal(resolveStructuredProvider({ task: 'demo' }).name, 'openrouter');
  });

  it('throws when no provider is configured', () => {
    assert.throws(() => resolveStructuredProvider({ task: 'demo' }), /LLM_PROVIDER=local.*OPENROUTER_API_KEY\/GROQ_API_KEY/);
  });

  it('requires a task, because it selects the env prefix', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    assert.throws(() => resolveStructuredProvider({}), /task name is required/);
  });
});

describe('response parsing', () => {
  it('strips a code fence the model added anyway', () => {
    assert.deepEqual(parseJsonPayload('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonPayload('```\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonPayload('  {"a":1}  '), { a: 1 });
  });

  it('extracts text from all three response shapes', () => {
    assert.equal(extractStructuredText({ choices: [{ message: { content: 'plain' } }] }), 'plain');
    assert.equal(extractStructuredText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
    assert.equal(extractStructuredText({ output_text: 'responses-api' }), 'responses-api');
    assert.equal(
      extractStructuredText({ output: [{ content: [{ type: 'output_text', text: 'nested' }] }] }),
      'nested'
    );
  });

  it('spells the schema out in prose, keeping the word JSON', () => {
    const instructions = buildJsonSchemaInstructions(SCHEMA);
    // Groq rejects json_object mode unless the messages mention JSON.
    assert.ok(/json/i.test(instructions));
    assert.ok(instructions.includes('"additionalProperties"'));
  });
});

describe('generateStructured', () => {
  it('returns validated data on the first attempt', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    const fetchFn = stubFetch(['{"value":"ok"}']);

    const result = await generateStructured({
      task: 'demo',
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema: SCHEMA,
      schemaName: 'demo',
      validate: () => {},
      fetchFn,
    });

    assert.deepEqual(result.data, { value: 'ok' });
    assert.equal(result.attempts, 1);
    assert.equal(result.provider, 'groq');
    assert.equal(fetchFn.calls.length, 1);
  });

  it('does not send an Authorization header to a keyless local endpoint', async () => {
    process.env.LLM_PROVIDER = 'local';
    const fetchFn = stubFetch(['{"value":"ok"}']);
    await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user', schema: SCHEMA,
      schemaName: 'demo', validate: () => {}, fetchFn,
    });
    assert.equal(fetchFn.calls[0].url, 'http://vllm:8000/v1/chat/completions');
    assert.equal(fetchFn.calls[0].options.headers.Authorization, undefined);
  });

  it('appends the schema to the system prompt only for a non-strict provider', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    const groqFetch = stubFetch(['{"value":"ok"}']);
    await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn: groqFetch,
    });
    assert.ok(/JSON Schema/i.test(groqFetch.calls[0].body.messages[0].content));

    delete process.env.GROQ_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-key';
    const orFetch = stubFetch(['{"value":"ok"}']);
    await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn: orFetch,
    });
    assert.equal(orFetch.calls[0].body.messages[0].content, 'sys');
  });

  it('feeds the validator message back as the correction turn', async () => {
    // This is what makes a second attempt worth paying for. A bare "try again"
    // reliably reproduces the same defect.
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '2';
    const fetchFn = stubFetch(['{"value":"bad"}', '{"value":"good"}']);

    let seen = 0;
    const result = await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo',
      validate: data => {
        seen += 1;
        if (data.value !== 'good') throw new Error('value must be exactly "good", got "bad"');
      },
      retryInstructions: ['Stay grounded in the sources.'],
      fetchFn,
    });

    assert.equal(seen, 2);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.data, { value: 'good' });

    const secondMessages = fetchFn.calls[1].body.messages;
    assert.equal(secondMessages.length, 3, 'the correction turn must be an extra message');
    const correction = secondMessages[2];
    assert.equal(correction.role, 'user');
    assert.ok(
      correction.content.includes('value must be exactly "good", got "bad"'),
      'the validator message itself must reach the model'
    );
    assert.ok(correction.content.includes('Stay grounded in the sources.'));
  });

  it('throws with the last rejection reason once attempts are exhausted', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '2';
    const fetchFn = stubFetch(['{"value":"bad"}']);

    await assert.rejects(
      generateStructured({
        task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
        schema: SCHEMA, schemaName: 'demo',
        validate: () => { throw new Error('always wrong'); },
        fetchFn,
      }),
      /after 2 attempt\(s\): always wrong/
    );
    assert.equal(fetchFn.calls.length, 2);
  });

  it('honours a caller default above the provider default', async () => {
    // Groq's provider default is 1 attempt, tuned for large outputs. A task with
    // a small payload can afford a correction round.
    process.env.GROQ_API_KEY = 'groq-key';
    const fetchFn = stubFetch(['{"value":"bad"}']);

    await assert.rejects(generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo',
      validate: () => { throw new Error('nope'); },
      defaults: { maxAttempts: 2 },
      fetchFn,
    }));
    assert.equal(fetchFn.calls.length, 2, 'caller default must beat the provider default');
  });

  it('lets env override the caller default', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '1';
    const fetchFn = stubFetch(['{"value":"bad"}']);

    await assert.rejects(generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo',
      validate: () => { throw new Error('nope'); },
      defaults: { maxAttempts: 3 },
      fetchFn,
    }));
    assert.equal(fetchFn.calls.length, 1, 'env is the operational dial and must win');
  });

  it('surfaces a non-2xx provider response', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    const fetchFn = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });

    await assert.rejects(
      generateStructured({
        task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
        schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn,
      }),
      /429.*rate limited/
    );
  });

  it('retries a 429 instead of failing the whole call on the first attempt', async () => {
    // Regression: requestCompletion's own errors used to sit outside the
    // try/catch driving the retry loop, so a transient provider error
    // propagated straight out — skipping the self-correcting retry that
    // exists for exactly this. A 429 is retryable and must consume an
    // attempt, not end the call.
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '2';
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return {
        ok: true,
        json: async () => ({ model: 'stub', choices: [{ message: { content: '{"value":"ok"}' } }] }),
      };
    };

    const result = await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn,
    });

    assert.equal(calls, 2, 'the 429 must consume an attempt and retry, not end the call');
    assert.deepEqual(result.data, { value: 'ok' });
  });

  it('does not retry a terminal status like 402, even with attempts remaining', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '3';
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 402, text: async () => 'insufficient credits' };
    };

    await assert.rejects(
      generateStructured({
        task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
        schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn,
      }),
      /402.*insufficient credits/
    );
    assert.equal(calls, 1, 'a terminal status must fail fast, not burn every attempt on a result that cannot change');
  });

  it('retries a network failure or timeout the same way as a retryable status', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GROQ_DEMO_ATTEMPTS = '2';
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return {
        ok: true,
        json: async () => ({ model: 'stub', choices: [{ message: { content: '{"value":"ok"}' } }] }),
      };
    };

    const result = await generateStructured({
      task: 'demo', systemPrompt: 'sys', userPrompt: 'user',
      schema: SCHEMA, schemaName: 'demo', validate: () => {}, fetchFn,
    });

    assert.equal(calls, 2);
    assert.deepEqual(result.data, { value: 'ok' });
  });

  it('requires a validator, since it is what drives the retry', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    await assert.rejects(
      generateStructured({ task: 'demo', schema: SCHEMA, schemaName: 'demo' }),
      /validate\(data\) function is required/
    );
  });
});
