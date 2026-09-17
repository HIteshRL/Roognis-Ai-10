/**
 * Generic structured-output LLM seam.
 *
 * One place to ask an OpenAI-compatible provider for a JSON object that
 * conforms to a schema, with a self-correcting retry loop: when the caller's
 * validator rejects a response, its error message is fed back to the model as
 * the next turn's instruction rather than being thrown away.
 *
 * ── This file is COPY #6. Named debt, not an oversight ─────────────────────
 * A near-verbatim fork of services/ai/structured-llm.js. Provider selection now
 * exists six times across the repo:
 *
 *   1. `resolveQuizProvider`        — ai/quiz-draft.js  (has a Groq fallback)
 *   2. `streamLlmResponse`          — ai/server.js      (plain switch, NO fallback)
 *   3. the `OPENROUTER_API_KEY ? … : …` ternary in ai/server.js's quiz-draft route
 *   4. `resolveStructuredProvider`  — ai/structured-llm.js (the intended seam)
 *   5. services/practice/structured-llm.js
 *   6. this file
 *
 * The fork exists for the same reason #5 does: there is no monorepo tooling and
 * no cross-service imports anywhere in this repo, so a separate deployable
 * cannot require() the ai copy. That is a real constraint, but six copies is
 * still six places a provider fix has to land. Recorded in HANDOFF.md.
 *
 * If you are fixing a provider bug, grep for `resolveStructuredProvider` and
 * `OPENROUTER_API_KEY` across services/ before assuming this file is the only
 * one that needs it.
 *
 * ── Schemas are shape-only ─────────────────────────────────────────────────
 * OpenAI strict `json_schema` mode ignores or rejects `minItems`, `maxItems`,
 * `minimum`, `maximum` and `pattern`. Passing a schema here buys you key names,
 * types and required-ness — nothing numeric. Every bound must live in the
 * `validate` function you supply, which is also what drives the retry.
 */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5-mini';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_LOCAL_BASE_URL = 'http://vllm:8000/v1';
const DEFAULT_LOCAL_MODEL = 'Qwen/Qwen3-32B';

const FALLBACK_TIMEOUT_MS = 60000;
const FALLBACK_MAX_COMPLETION_TOKENS = 4200;
const MAX_ALLOWED_ATTEMPTS = 3;

/**
 * Normalize a task name into the infix used for its environment knobs.
 *
 * `'visuals'` → `VISUALS`, which yields OPENROUTER_VISUALS_MODEL,
 * GROQ_VISUALS_TIMEOUT_MS, and so on.
 */
function normalizeTask(task) {
  const value = String(task || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!value) throw new Error('structured-llm: a task name is required (it selects the env knob prefix).');
  return value;
}

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback).trim().replace(/\/+$/, '');
}

function assertOpenRouterOpenAiModel(model) {
  const value = String(model || '').trim();
  if (!value.startsWith('openai/') && !value.startsWith('~openai/')) {
    throw new Error('OpenRouter model must be an OpenAI-family slug such as openai/gpt-5-mini.');
  }
}

function openRouterAttributionHeaders(config = {}) {
  const headers = {};
  const referer = config.siteUrl || process.env.OPENROUTER_SITE_URL;
  const title = config.appName || process.env.OPENROUTER_APP_NAME || 'Roognis';
  if (referer) headers['HTTP-Referer'] = referer;
  if (title) headers['X-OpenRouter-Title'] = title;
  return headers;
}

/**
 * Pick a provider for `task`.
 *
 * `LLM_PROVIDER` (or `config.llmProvider`), when set to a provider whose key
 * is actually present, wins outright — this is the operator's explicit
 * configuration and must not be silently overridden. Without a usable
 * preference, falls back to key-presence selection, preferring OpenRouter
 * over Groq. (Previously this was key-presence-only, so `LLM_PROVIDER=groq`
 * with both keys set — a real, observed production config — still always
 * chose OpenRouter. Same fix as services/ai/structured-llm.js.)
 *
 * The two branches are not interchangeable. OpenRouter supports strict
 * json_schema natively and `provider: { require_parameters: true }` keeps the
 * request off upstreams that would silently ignore it. Groq's OpenAI-compatible
 * models do not honour strict schema reliably, so that branch uses json_object
 * mode and the schema is spelled out in the system prompt instead
 * (`buildJsonSchemaInstructions`), leaning on the validate-and-retry loop.
 */
function resolveStructuredProvider({ task, config = {} } = {}) {
  const taskKey = normalizeTask(task);

  const openrouterApiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY;
  const groqApiKey = config.groqApiKey || process.env.GROQ_API_KEY;
  const preferredProvider = String(config.llmProvider || process.env.LLM_PROVIDER || '').trim().toLowerCase();

  const buildLocal = () => {
    const model = config.localModel || process.env[`LOCAL_LLM_${taskKey}_MODEL`]
      || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
    const strictSchema = String(
      config.localJsonSchema ?? process.env.LOCAL_LLM_JSON_SCHEMA ?? 'true'
    ).toLowerCase() !== 'false';
    return {
      name: 'local', task: taskKey, envPrefix: 'LOCAL_LLM',
      apiKey: config.localApiKey ?? process.env.LOCAL_LLM_API_KEY ?? '', model,
      baseUrl: normalizeBaseUrl(config.localBaseUrl || process.env.LOCAL_LLM_BASE_URL, DEFAULT_LOCAL_BASE_URL),
      extraHeaders: {}, strictSchema,
      defaults: { ATTEMPTS: 2, MAX_COMPLETION_TOKENS: 4200, TIMEOUT_MS: 120000 },
      buildRequestBody: (messages, opts) => ({
        model, messages,
        response_format: strictSchema ? {
          type: 'json_schema',
          json_schema: { name: opts.schemaName, description: opts.schemaDescription, strict: true, schema: opts.schema },
        } : { type: 'json_object' },
        max_tokens: opts.maxCompletionTokens,
        temperature: 0.2,
      }),
    };
  };

  const buildOpenRouter = () => {
    const model = config.model || process.env[`OPENROUTER_${taskKey}_MODEL`] || DEFAULT_OPENROUTER_MODEL;
    assertOpenRouterOpenAiModel(model);
    return {
      name: 'openrouter',
      task: taskKey,
      envPrefix: 'OPENROUTER',
      apiKey: openrouterApiKey,
      model,
      baseUrl: normalizeBaseUrl(
        config.baseUrl || process.env.OPENROUTER_API_BASE_URL,
        DEFAULT_OPENROUTER_BASE_URL
      ),
      extraHeaders: openRouterAttributionHeaders(config),
      strictSchema: true,
      defaults: { ATTEMPTS: 2, MAX_COMPLETION_TOKENS: 4200, TIMEOUT_MS: 60000 },
      buildRequestBody: (messages, opts) => ({
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: opts.schemaName,
            description: opts.schemaDescription,
            strict: true,
            schema: opts.schema,
          },
        },
        provider: { require_parameters: true },
        reasoning: { effort: opts.reasoningEffort },
        max_completion_tokens: opts.maxCompletionTokens,
      }),
    };
  };

  const buildGroq = () => {
    const model = config.model || process.env[`GROQ_${taskKey}_MODEL`] || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    return {
      name: 'groq',
      task: taskKey,
      envPrefix: 'GROQ',
      apiKey: groqApiKey,
      model,
      baseUrl: normalizeBaseUrl(config.baseUrl || process.env.GROQ_API_BASE_URL, DEFAULT_GROQ_BASE_URL),
      extraHeaders: {},
      strictSchema: false,
      // Groq's free tier caps this class of model at 12,000 tokens/minute.
      // These are deliberately conservative because they have to be safe for the
      // largest caller; a task producing small outputs should raise them through
      // its own `defaults`, which sit above these in the precedence order.
      defaults: { ATTEMPTS: 1, MAX_COMPLETION_TOKENS: 2400, TIMEOUT_MS: 60000 },
      buildRequestBody: (messages, opts) => ({
        model,
        messages,
        response_format: { type: 'json_object' },
        // Groq uses the older `max_tokens` spelling, not `max_completion_tokens`.
        max_tokens: opts.maxCompletionTokens,
        temperature: 0.2,
        // gpt-oss models spend completion tokens on a hidden reasoning trace
        // before the JSON body — observed live: an unconstrained gpt-oss-120b
        // call burned its entire max_tokens budget on `reasoning` and returned
        // empty `content` (finish_reason "length"). Capping effort to 'low'
        // leaves the budget for the actual payload. llama-3.3 and other
        // non-gpt-oss Groq models don't have this field, so gate it by model
        // name rather than adding it unconditionally for every Groq task.
        ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
    };
  };

  if (['local', 'vllm', 'openai-compatible'].includes(preferredProvider)) return buildLocal();
  if (preferredProvider === 'groq' && groqApiKey) return buildGroq();
  if (preferredProvider === 'openrouter' && openrouterApiKey) return buildOpenRouter();

  if (openrouterApiKey) return buildOpenRouter();
  if (groqApiKey) return buildGroq();

  throw new Error(`Set LLM_PROVIDER=local or configure OPENROUTER_API_KEY/GROQ_API_KEY for ${taskKey.toLowerCase()} generation.`);
}

/**
 * Spell a JSON Schema out in prose for providers without strict schema support.
 *
 * The literal word "JSON" must survive into the prompt: Groq rejects
 * `response_format: { type: 'json_object' }` unless the messages mention it.
 */
function buildJsonSchemaInstructions(schema) {
  return [
    'Respond with a single JSON object only — no markdown, no code fences, no commentary before or after it.',
    'The JSON object must conform exactly to this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * A provider request that failed before a model response could be judged —
 * network failure, timeout, non-2xx status, or an empty completion. Carries
 * `retryable` so the caller can distinguish a transient failure (worth
 * spending another attempt on) from a terminal one (a bad API key will not
 * succeed on retry, so failing fast is correct).
 */
class ProviderRequestError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Parse a JSON payload, tolerating a ```json fence the model added anyway. */
function parseJsonPayload(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/**
 * Pull assistant text out of a completion, across the three response shapes
 * these providers actually return: a plain string, an array of content parts,
 * or the Responses-API `output_text` / `output[].content[]` layout.
 */
function extractStructuredText(response) {
  const choiceContent = response?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return choiceContent;
  if (Array.isArray(choiceContent)) {
    return choiceContent.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
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

/**
 * Resolve one operational knob.
 *
 * Precedence is env > caller default > provider default. Environment wins over
 * code because these are operational dials that have to be turnable on a
 * running deployment without a rebuild.
 *
 * `provider.defaults` is keyed by the same ENV_NAME used to look the knob up,
 * deliberately: deriving one from the other by string transformation lets a
 * rename miss silently and fall through to the fallback constant.
 */
function resolveKnob(provider, envName, callerDefault) {
  const envValue = process.env[`${provider.envPrefix}_${provider.task}_${envName}`];
  const chosen = [envValue, callerDefault, provider.defaults?.[envName]]
    .find(value => value !== undefined && value !== null && value !== '');
  return chosen === undefined ? NaN : Number(chosen);
}

function normalizeAttempts(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_ALLOWED_ATTEMPTS) {
    throw new Error(`structured-llm: attempts must be an integer from 1 to ${MAX_ALLOWED_ATTEMPTS}.`);
  }
  return numeric;
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Ask a provider for a schema-conforming JSON object, validating and retrying.
 *
 * `validate(data)` must throw when the payload is unacceptable; its message is
 * both the reason surfaced to the caller on final failure and the correction
 * handed to the model on the next attempt. A validator that throws vague
 * messages produces vague retries, so validators should say precisely what was
 * wrong and what the bound is.
 *
 * Returns `{ data, model, provider, usage, attempts }`.
 */
async function generateStructured({
  task,
  systemPrompt,
  userPrompt,
  schema,
  schemaName,
  schemaDescription = '',
  validate,
  retryInstructions = [],
  defaults = {},
  config = {},
  fetchFn = fetch,
} = {}) {
  if (typeof validate !== 'function') {
    throw new Error('structured-llm: a validate(data) function is required — it is what makes the retry self-correcting.');
  }
  if (!schema || typeof schema !== 'object') {
    throw new Error('structured-llm: a schema object is required.');
  }
  if (!schemaName) {
    throw new Error('structured-llm: a schemaName is required (providers use it to label the response format).');
  }

  const provider = resolveStructuredProvider({ task, config });

  const timeoutMs = positiveOr(resolveKnob(provider, 'TIMEOUT_MS', defaults.timeoutMs), FALLBACK_TIMEOUT_MS);
  const maxCompletionTokens = positiveOr(
    resolveKnob(provider, 'MAX_COMPLETION_TOKENS', defaults.maxCompletionTokens),
    FALLBACK_MAX_COMPLETION_TOKENS
  );
  const resolvedAttempts = resolveKnob(provider, 'ATTEMPTS', defaults.maxAttempts);
  const maxAttempts = normalizeAttempts(Number.isFinite(resolvedAttempts) ? resolvedAttempts : 1);
  const reasoningEffort =
    config.reasoningEffort || process.env[`OPENROUTER_${provider.task}_REASONING_EFFORT`] || 'medium';

  const requestCompletion = async messages => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchFn(`${provider.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
          method: 'POST',
          headers: {
            ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
            'Content-Type': 'application/json',
            ...provider.extraHeaders,
          },
          body: JSON.stringify(
            provider.buildRequestBody(messages, {
              reasoningEffort,
              maxCompletionTokens,
              schema,
              schemaName,
              schemaDescription,
            })
          ),
          signal: controller.signal,
        });
      } catch (networkError) {
        // Never reached the provider at all (DNS/connection failure) or our
        // own timeout fired (AbortError) — always safe to retry.
        const timedOut = networkError?.name === 'AbortError';
        throw new ProviderRequestError(
          `${provider.name} ${provider.task.toLowerCase()} generation ${timedOut ? 'timed out' : 'failed'}: ${networkError.message}`,
          { retryable: true }
        );
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new ProviderRequestError(
          `${provider.name} ${provider.task.toLowerCase()} generation failed with ${response.status}: ${errorBody}`,
          { status: response.status, retryable: RETRYABLE_STATUS_CODES.has(response.status) }
        );
      }
      const raw = await response.json();
      const text = extractStructuredText(raw);
      if (!text) {
        throw new ProviderRequestError(
          `${provider.name} ${provider.task.toLowerCase()} generation returned no output text.`,
          { retryable: true }
        );
      }
      return { raw, text };
    } finally {
      clearTimeout(timeout);
    }
  };

  const resolvedSystemPrompt = provider.strictSchema
    ? systemPrompt
    : `${systemPrompt}\n\n${buildJsonSchemaInstructions(schema)}`;

  let rejectionReason = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = [
      { role: 'system', content: resolvedSystemPrompt },
      { role: 'user', content: userPrompt },
    ];

    // The correction turn. Handing the validator's own message back is what
    // makes a second attempt worth spending — a bare "try again" reliably
    // reproduces the same defect.
    if (rejectionReason) {
      messages.push({
        role: 'user',
        content: [
          'Your previous response was rejected by an automatic validator.',
          `Rejection reason: ${rejectionReason}`,
          'Produce a corrected response that satisfies that constraint.',
          ...retryInstructions,
        ].join('\n'),
      });
    }

    // A provider-request failure (HTTP error, timeout, empty completion) never
    // reached the point of producing a judgeable response, so it is handled
    // separately from a validator rejection: retryable statuses (429, 5xx,
    // timeouts) get another attempt without touching `rejectionReason` — there
    // is no "previous response" to correct, so the retry sends the same
    // messages again rather than a misleading correction turn. A terminal
    // status (401, 402, ...) fails immediately; retrying a bad API key wastes
    // attempts and time for a result that cannot change.
    let generated;
    try {
      generated = await requestCompletion(messages);
    } catch (error) {
      if (error instanceof ProviderRequestError && error.retryable && attempt < maxAttempts) {
        continue;
      }
      throw error;
    }

    try {
      const data = parseJsonPayload(generated.text);
      validate(data);
      return {
        data,
        model: generated.raw.model || provider.model,
        provider: provider.name,
        usage: generated.raw.usage || null,
        attempts: attempt,
      };
    } catch (error) {
      rejectionReason = error.message || 'The response did not satisfy the validator.';
      if (attempt === maxAttempts) {
        throw new Error(
          `${provider.task.toLowerCase()} generation failed validation after ${attempt} attempt(s): ${rejectionReason}`
        );
      }
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt, and
  // maxAttempts is guaranteed >= 1 by normalizeAttempts.
  throw new Error(`${provider.task.toLowerCase()} generation exhausted all attempts.`);
}

module.exports = {
  resolveStructuredProvider,
  generateStructured,
  parseJsonPayload,
  extractStructuredText,
  buildJsonSchemaInstructions,
  assertOpenRouterOpenAiModel,
  ProviderRequestError,
};
