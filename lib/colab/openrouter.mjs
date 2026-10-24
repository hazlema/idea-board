// A small OpenRouter client: the model list and chat completions with cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://openrouter.ai/api/v1';
const MODELS_TTL = 60 * 60 * 1000;
const ATTEMPTS = 3;
const TIMEOUT_MS = 300_000; // per attempt

export function readKey(env = process.env, home = os.homedir()) {
  if (env.OPENROUTER_API_KEY?.trim()) return env.OPENROUTER_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(home, '.config/openrouter/key'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

const perMillion = (price) => Math.round(Number(price ?? 0) * 1e6 * 1e6) / 1e6;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRouter {
  #key;
  #fetch;
  #sleep;
  #models = null;
  #modelsAt = 0;

  constructor({ key, fetch = globalThis.fetch, sleep = defaultSleep } = {}) {
    this.#key = key;
    this.#fetch = fetch;
    this.#sleep = sleep;
  }

  #readKey() {
    return (typeof this.#key === 'function' ? this.#key() : this.#key) || null;
  }

  hasKey() {
    return Boolean(this.#readKey());
  }

  async models() {
    if (this.#models && Date.now() - this.#modelsAt < MODELS_TTL) return this.#models;
    const res = await this.#fetch(`${BASE}/models`);
    const body = parse(res, await res.text());
    this.#models = (body.data ?? [])
      .filter((m) => m.supported_parameters?.includes('tools'))
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        promptPrice: perMillion(m.pricing?.prompt),
        completionPrice: perMillion(m.pricing?.completion),
        context: m.context_length ?? 0,
      }));
    this.#modelsAt = Date.now();
    return this.#models;
  }

  // `signal` lets the caller cut the call short (a turn's time limit, Stop); that is never retried.
  async complete({ model, messages, tools, settings, signal }) {
    const key = this.#readKey();
    if (!key) throw new OpenRouterError('No OpenRouter key', 401);
    const request = {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'idea-board' },
      body: JSON.stringify({ ...settings, model, messages, tools, usage: { include: true } }),
    };
    for (let attempt = 1; ; attempt += 1) {
      let res;
      let raw;
      try {
        const limit = AbortSignal.timeout(TIMEOUT_MS);
        res = await this.#fetch(`${BASE}/chat/completions`, { ...request, signal: signal ? AbortSignal.any([signal, limit]) : limit });
        raw = await res.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Only a dropped connection retries (after 2s, then 8s).
        if (attempt === ATTEMPTS) throw new OpenRouterError(`${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}`, 0);
        await this.#sleep(attempt * attempt * 2000);
        continue;
      }
      const body = parse(res, raw);
      const message = body.choices?.[0]?.message;
      if (!message) throw new OpenRouterError('OpenRouter returned no message', res.status);
      // Prompt tokens, and how many of them the provider read from its cache.
      const usage = body.usage ?? {};
      return { message, cost: Number(usage.cost ?? 0), promptTokens: Number(usage.prompt_tokens ?? 0), cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) };
    }
  }
}

function parse(res, raw) {
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // not JSON (an HTML error page, say)
  }
  if (!res.ok || body?.error) throw new OpenRouterError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
  if (!body) throw new OpenRouterError(`HTTP ${res.status}`, res.status);
  return body;
}
