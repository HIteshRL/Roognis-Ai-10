'use strict';

const { createHash, randomUUID } = require('node:crypto');

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseProviderOrder(value) {
  const allowed = new Set(['nim', 'ollama', 'gemini']);
  const seen = new Set();
  return String(value || 'nim,ollama,gemini')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => allowed.has(item) && !seen.has(item) && (seen.add(item), true));
}

function createVisionConfig(env = process.env) {
  const mode = ['disabled', 'auto', 'always'].includes(String(env.VISION_MODE || 'auto').toLowerCase())
    ? String(env.VISION_MODE || 'auto').toLowerCase()
    : 'auto';
  return {
    enabled: asBoolean(env.VISION_ENABLED, false),
    mode,
    providerOrder: parseProviderOrder(env.VISION_PROVIDER_ORDER),
    totalTimeoutMs: positiveInteger(env.TUTOR_TOTAL_TIMEOUT_MS, 60000, { max: 120000 }),
    phaseTimeoutMs: positiveInteger(env.VISION_PHASE_TIMEOUT_MS, 30000, { max: 90000 }),
    textFallbackReserveMs: positiveInteger(env.VISION_TEXT_FALLBACK_RESERVE_MS, 25000, { max: 90000 }),
    maxImageBytes: positiveInteger(env.VISION_MAX_IMAGE_BYTES, 4 * 1024 * 1024, { max: 12 * 1024 * 1024 }),
    maxRequestBytes: positiveInteger(env.VISION_MAX_REQUEST_BYTES, 7 * 1024 * 1024, { max: 16 * 1024 * 1024 }),
    maxConcurrent: positiveInteger(env.VISION_MAX_CONCURRENT, 8, { max: 1000 }),
    circuitFailureThreshold: positiveInteger(env.VISION_CIRCUIT_FAILURE_THRESHOLD, 3, { max: 20 }),
    circuitOpenMs: positiveInteger(env.VISION_CIRCUIT_OPEN_MS, 60000, { max: 10 * 60 * 1000 }),
    nim: {
      baseUrl: String(env.NIM_VISION_BASE_URL || '').replace(/\/+$/, ''),
      model: String(env.NIM_VISION_MODEL || '').trim(),
      apiKey: String(env.NIM_VISION_API_KEY || '').trim(),
      timeoutMs: positiveInteger(env.NIM_VISION_TIMEOUT_MS, 20000, { max: 60000 }),
    },
    ollama: {
      baseUrl: String(env.OLLAMA_VISION_URL || env.OLLAMA_URL || 'http://ollama:11434').replace(/\/+$/, ''),
      model: String(env.OLLAMA_VISION_MODEL || 'gemma3').trim(),
      timeoutMs: positiveInteger(env.OLLAMA_VISION_TIMEOUT_MS, 8000, { max: 60000 }),
    },
    gemini: {
      baseUrl: String(env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      model: String(env.GEMINI_VISION_MODEL || '').replace(/^models\//, '').trim(),
      apiKey: String(env.GEMINI_API_KEY || '').trim(),
      timeoutMs: positiveInteger(env.GEMINI_VISION_TIMEOUT_MS, 10000, { max: 60000 }),
      hostedEnabled: asBoolean(env.VISION_HOSTED_FALLBACK_ENABLED, false),
      schoolAllowlist: new Set(String(env.VISION_HOSTED_SCHOOL_ALLOWLIST || '').split(',').map(value => value.trim()).filter(Boolean)),
    },
  };
}

function normalizeReaderContext(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'readerContext must be an object.' };
  const page = value.page;
  if (!Number.isInteger(page) || page < 1 || page > 10000) {
    return { ok: false, error: 'readerContext.page must be a whole number from 1 to 10000.' };
  }
  if (value.usePage !== undefined && typeof value.usePage !== 'boolean') {
    return { ok: false, error: 'readerContext.usePage must be true or false.' };
  }
  return { ok: true, value: { page, usePage: value.usePage === true } };
}

function questionAppearsVisual(question) {
  return /\b(this|the)\s+(diagram|figure|graph|chart|table|image|picture|map|line|shape|angle|equation|label|drawing)\b|\b(see|shown|visible|above|below|here|on\s+this\s+page)\b/i.test(String(question || ''));
}

function shouldUseVision({ config, readerContext, question }) {
  if (!config.enabled || config.mode === 'disabled' || !readerContext) return false;
  if (config.mode === 'always') return true;
  return readerContext.usePage || questionAppearsVisual(question);
}

function createAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Vision provider timed out.')), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('Request cancelled.'));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    },
  };
}

class VisionProviderError extends Error {
  constructor(category, message, { retryable = false } = {}) {
    super(message);
    this.name = 'VisionProviderError';
    this.category = category;
    this.retryable = retryable;
  }
}

function normaliseContent(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(item => item?.text || '').join('').trim();
  return '';
}

async function readProviderError(response) {
  const body = await response.text().catch(() => '');
  return `${response.status}${body ? ` ${body.slice(0, 240)}` : ''}`;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function configuredProvider(config, provider, schoolId) {
  if (provider === 'nim') return Boolean(config.nim.baseUrl && config.nim.model);
  if (provider === 'ollama') return Boolean(config.ollama.baseUrl && config.ollama.model);
  if (provider === 'gemini') {
    return Boolean(
      config.gemini.baseUrl && config.gemini.model && config.gemini.apiKey
      && config.gemini.hostedEnabled && config.gemini.schoolAllowlist.has(schoolId),
    );
  }
  return false;
}

async function callNim({ fetchFn, config, prompt, image, signal, timeoutMs }) {
  const controller = createAbortSignal(signal, timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.nim.apiKey) headers.Authorization = `Bearer ${config.nim.apiKey}`;
    const response = await fetchFn(`${config.nim.baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({
        model: config.nim.model,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new VisionProviderError(isRetryableStatus(response.status) ? 'provider_unavailable' : 'provider_rejected', `NIM vision failed: ${await readProviderError(response)}`, { retryable: isRetryableStatus(response.status) });
    const data = await response.json();
    const content = normaliseContent(data?.choices?.[0]?.message?.content);
    if (!content) throw new VisionProviderError('empty_response', 'NIM vision returned no answer.', { retryable: true });
    return { content, model: data?.model || config.nim.model };
  } catch (error) {
    if (error instanceof VisionProviderError) throw error;
    if (controller.signal.aborted) throw new VisionProviderError('timeout', 'NIM vision timed out.', { retryable: true });
    throw new VisionProviderError('connection', 'NIM vision could not be reached.', { retryable: true });
  } finally { controller.dispose(); }
}

async function callOllama({ fetchFn, config, prompt, image, signal, timeoutMs }) {
  const controller = createAbortSignal(signal, timeoutMs);
  try {
    const response = await fetchFn(`${config.ollama.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        model: config.ollama.model,
        stream: false,
        messages: [{ role: 'user', content: prompt, images: [image.base64] }],
        options: { temperature: 0.2 },
      }),
    });
    if (!response.ok) throw new VisionProviderError(isRetryableStatus(response.status) ? 'provider_unavailable' : 'provider_rejected', `Ollama vision failed: ${await readProviderError(response)}`, { retryable: isRetryableStatus(response.status) });
    const data = await response.json();
    const content = normaliseContent(data?.message?.content);
    if (!content) throw new VisionProviderError('empty_response', 'Ollama vision returned no answer.', { retryable: true });
    return { content, model: data?.model || config.ollama.model };
  } catch (error) {
    if (error instanceof VisionProviderError) throw error;
    if (controller.signal.aborted) throw new VisionProviderError('timeout', 'Ollama vision timed out.', { retryable: true });
    throw new VisionProviderError('connection', 'Ollama vision could not be reached.', { retryable: true });
  } finally { controller.dispose(); }
}

async function callGemini({ fetchFn, config, prompt, image, signal, timeoutMs }) {
  const controller = createAbortSignal(signal, timeoutMs);
  try {
    const response = await fetchFn(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: image.mimeType, data: image.base64 } },
        ] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!response.ok) throw new VisionProviderError(isRetryableStatus(response.status) ? 'provider_unavailable' : 'provider_rejected', `Gemini vision failed: ${await readProviderError(response)}`, { retryable: isRetryableStatus(response.status) });
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    if (data?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') {
      throw new VisionProviderError('safety_rejected', 'Gemini vision rejected the request.', { retryable: false });
    }
    const content = normaliseContent(candidate?.content?.parts);
    if (!content) throw new VisionProviderError('empty_response', 'Gemini vision returned no answer.', { retryable: true });
    return { content, model: config.gemini.model };
  } catch (error) {
    if (error instanceof VisionProviderError) throw error;
    if (controller.signal.aborted) throw new VisionProviderError('timeout', 'Gemini vision timed out.', { retryable: true });
    throw new VisionProviderError('connection', 'Gemini vision could not be reached.', { retryable: true });
  } finally { controller.dispose(); }
}

function createVisionRouter({ env = process.env, fetchFn = global.fetch, now = () => Date.now(), logger = console, createClient } = {}) {
  const config = createVisionConfig(env);
  const localCircuits = new Map();
  const redisUrl = String(env.REDIS_URL || '').trim();
  let redisClient = null;
  let redisConnecting = null;

  async function getRedis() {
    if (!redisUrl) return null;
    if (!createClient) {
      // Lazy require keeps unit tests and VISION_ENABLED=false startup paths
      // free of a Redis connection until a visual turn is actually requested.
      createClient = require('redis').createClient;
    }
    if (!redisClient) {
      redisClient = createClient({ url: redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
      redisClient.on?.('error', () => {});
    }
    if (!redisClient.isOpen) {
      redisConnecting ||= redisClient.connect().finally(() => { redisConnecting = null; });
      await redisConnecting;
    }
    return redisClient;
  }

  async function acquireVisionLease(signal) {
    const db = await getRedis().catch(() => null);
    if (!db) return { acquired: false, reason: 'admission_unavailable', release: () => {} };
    const token = randomUUID();
    const nowMs = now();
    const leaseMs = Math.max(config.phaseTimeoutMs + 10000, 45000);
    try {
      const accepted = await db.eval(`
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
        redis.call('EXPIRE', KEYS[1], ARGV[5])
        return 1`, {
        keys: ['roognis:ai:vision:active'],
        arguments: [String(nowMs), String(nowMs + leaseMs), String(config.maxConcurrent), token, String(Math.ceil(leaseMs / 1000) + 30)],
      });
      if (Number(accepted) !== 1) return { acquired: false, reason: 'capacity_exhausted', release: () => {} };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        db.zRem('roognis:ai:vision:active', token).catch(() => {});
      };
      signal?.addEventListener?.('abort', release, { once: true });
      return { acquired: true, release };
    } catch (error) {
      logger.warn?.(`[ai] vision admission unavailable: ${error.message}`);
      return { acquired: false, reason: 'admission_unavailable', release: () => {} };
    }
  }

  async function circuitIsOpen(provider) {
    const db = await getRedis().catch(() => null);
    if (db) {
      const value = await db.get(`roognis:ai:vision:circuit:${provider}`).catch(() => null);
      return Number(value || 0) > now();
    }
    const until = localCircuits.get(provider) || 0;
    if (until <= now()) {
      localCircuits.delete(provider);
      return false;
    }
    return true;
  }

  async function recordFailure(provider) {
    const db = await getRedis().catch(() => null);
    if (db) {
      const key = `roognis:ai:vision:failures:${provider}`;
      const failures = Number(await db.incr(key).catch(() => 0));
      await db.expire(key, Math.ceil(config.circuitOpenMs / 1000) + 30).catch(() => {});
      if (failures >= config.circuitFailureThreshold) {
        await db.set(`roognis:ai:vision:circuit:${provider}`, String(now() + config.circuitOpenMs), { PX: config.circuitOpenMs }).catch(() => {});
        await db.del(key).catch(() => {});
      }
      return;
    }
    const entry = localCircuits.get(`${provider}:failures`) || 0;
    const next = entry + 1;
    if (next >= config.circuitFailureThreshold) {
      localCircuits.set(provider, now() + config.circuitOpenMs);
      localCircuits.delete(`${provider}:failures`);
    } else {
      localCircuits.set(`${provider}:failures`, next);
    }
  }

  async function recordSuccess(provider) {
    const db = await getRedis().catch(() => null);
    if (db) {
      await db.del(`roognis:ai:vision:failures:${provider}`, `roognis:ai:vision:circuit:${provider}`).catch(() => {});
      return;
    }
    localCircuits.delete(provider);
    localCircuits.delete(`${provider}:failures`);
  }

  async function generate({ prompt, image, schoolId, signal, deadlineAt }) {
    const attempts = [];
    if (!config.enabled || config.mode === 'disabled') return { status: 'disabled', attempts };
    if (!image?.base64 || !schoolId) return { status: 'unavailable', attempts };
    const encodedLength = String(image.base64).length;
    const imageBytes = Math.floor(encodedLength * 3 / 4);
    const requestBytes = Buffer.byteLength(String(prompt || ''), 'utf8') + encodedLength + 2048;
    if (imageBytes > config.maxImageBytes || requestBytes > config.maxRequestBytes) {
      return { status: 'unavailable', attempts: ['image_too_large'] };
    }

    const lease = await acquireVisionLease(signal);
    if (!lease.acquired) return { status: 'unavailable', attempts: [lease.reason] };

    try {
      for (const provider of config.providerOrder) {
        if (!configuredProvider(config, provider, schoolId)) {
          attempts.push(`${provider}_not_configured`);
          continue;
        }
        if (await circuitIsOpen(provider)) {
          attempts.push(`${provider}_circuit_open`);
          continue;
        }
        const remaining = deadlineAt - now();
        if (remaining < 2500) break;
        const providerConfig = config[provider];
        const timeoutMs = Math.min(remaining, providerConfig.timeoutMs);
        const startedAt = now();
        try {
          let result;
          if (provider === 'nim') result = await callNim({ fetchFn, config, prompt, image, signal, timeoutMs });
          else if (provider === 'ollama') result = await callOllama({ fetchFn, config, prompt, image, signal, timeoutMs });
          else result = await callGemini({ fetchFn, config, prompt, image, signal, timeoutMs });
          await recordSuccess(provider);
          return {
            status: 'used', content: result.content, provider, model: result.model,
            latencyMs: now() - startedAt, attempts: [...attempts, `${provider}_used`],
          };
        } catch (error) {
          const failure = error instanceof VisionProviderError ? error : new VisionProviderError('unknown', 'Vision provider failed.', { retryable: true });
          attempts.push(`${provider}_${failure.category}`);
          if (failure.retryable) {
            await recordFailure(provider);
            continue;
          }
          if (failure.category === 'safety_rejected') return { status: 'safety_rejected', attempts };
          logger.warn?.(`[ai] ${provider} vision request failed: ${failure.category}`);
          return { status: 'unavailable', attempts };
        }
      }
      return { status: 'unavailable', attempts };
    } finally {
      lease.release();
    }
  }

  return { config, generate, shouldUseVision: args => shouldUseVision({ config, ...args }) };
}

function documentHash(documentId) {
  return createHash('sha256').update(String(documentId || '')).digest('hex').slice(0, 16);
}

function createRequestId() {
  return randomUUID();
}

module.exports = {
  VisionProviderError,
  createRequestId,
  createVisionConfig,
  createVisionRouter,
  documentHash,
  normalizeReaderContext,
  questionAppearsVisual,
  shouldUseVision,
};
