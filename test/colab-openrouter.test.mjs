import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouter, OpenRouterError, readKey } from '../lib/colab/openrouter.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const OK = json({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { cost: 0.012 } });
const args = { model: 'x/y', messages: [{ role: 'user', content: 'yo' }] };

test('complete returns the message and the cost, and sends the key', async () => {
  let seen;
  const client = new OpenRouter({ key: 'k', fetch: async (url, init) => ((seen = { url, init }), OK) });
  const result = await client.complete({ ...args, settings: { temperature: 0.5 } });
  assert.deepEqual(result, { message: { role: 'assistant', content: 'hi' }, cost: 0.012, promptTokens: 0, cachedTokens: 0 });
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.temperature, 0.5);
  assert.deepEqual(sent.usage, { include: true });
});

test('the key may be a function, read on each call', async () => {
  let key = null;
  const client = new OpenRouter({ key: () => key, fetch: async () => OK });
  assert.equal(client.hasKey(), false);
  await assert.rejects(client.complete(args), (e) => e instanceof OpenRouterError && e.status === 401 && e.message === 'No OpenRouter key');
  key = 'late';
  assert.equal(client.hasKey(), true);
  assert.equal((await client.complete(args)).cost, 0.012);
});

test('network errors retry after 2s then 8s', async () => {
  const sleeps = [];
  let calls = 0;
  const fetch = async () => {
    if (++calls <= 2) throw new TypeError('fetch failed');
    return OK;
  };
  const client = new OpenRouter({ key: 'k', fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.equal((await client.complete(args)).message.content, 'hi');
  assert.deepEqual(sleeps, [2000, 8000]);
});

test('three network failures throw', async () => {
  let calls = 0;
  const client = new OpenRouter({ key: 'k', fetch: async () => (calls++, Promise.reject(new TypeError('fetch failed'))), sleep: async () => {} });
  await assert.rejects(client.complete(args), /fetch failed/);
  assert.equal(calls, 3);
});

test('HTTP errors never retry and read the JSON message', async () => {
  let calls = 0;
  const fetch = async () => (calls++, json({ error: { message: 'Insufficient credits' } }, 402));
  const client = new OpenRouter({ key: 'k', fetch, sleep: async () => assert.fail('slept') });
  await assert.rejects(client.complete(args), (e) => e instanceof OpenRouterError && e.status === 402 && e.message === 'Insufficient credits');
  assert.equal(calls, 1);
});

test('a non-JSON error body becomes HTTP <status>', async () => {
  const fetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' });
  const client = new OpenRouter({ key: 'k', fetch });
  await assert.rejects(client.complete(args), (e) => e instanceof OpenRouterError && e.status === 502 && e.message === 'HTTP 502');
});

test('models keeps tool-capable entries, prices per million, and caches', async () => {
  let calls = 0;
  const data = [
    { id: 'a/tools', name: 'A', context_length: 1000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools', 'temperature'] },
    { id: 'b/plain', name: 'B', pricing: {}, supported_parameters: ['temperature'] },
  ];
  const client = new OpenRouter({ fetch: async () => (calls++, json({ data })) });
  const expected = [{ id: 'a/tools', name: 'A', promptPrice: 3, completionPrice: 15, context: 1000 }];
  assert.deepEqual(await client.models(), expected);
  assert.deepEqual(await client.models(), expected);
  assert.equal(calls, 1);
});

test('readKey prefers the environment, then the key file', () => {
  assert.equal(readKey({ OPENROUTER_API_KEY: ' abc ' }, '/nonexistent'), 'abc');
  assert.equal(readKey({}, '/nonexistent'), null);
});

test('a reply body that drops mid-read is retried like a dropped connection', async () => {
  const sleeps = [];
  let calls = 0;
  const fetch = async () => (++calls === 1 ? { ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } } : OK);
  const client = new OpenRouter({ key: 'k', fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.equal((await client.complete(args)).message.content, 'hi');
  assert.deepEqual(sleeps, [2000]);
  const dead = new OpenRouter({ key: 'k', fetch: async () => ({ ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } }), sleep: async () => {} });
  await assert.rejects(dead.complete(args), (e) => e instanceof OpenRouterError && e.status === 0 && /terminated/.test(e.message));
});

test('each attempt has a time limit, and a timeout is retried', async () => {
  const signals = [];
  let calls = 0;
  const fetch = async (url, init) => {
    signals.push(init.signal);
    if (++calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return OK;
  };
  const client = new OpenRouter({ key: 'k', fetch, sleep: async () => {} });
  assert.equal((await client.complete(args)).message.content, 'hi');
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});

test('complete reports prompt tokens and how many came from the cache', async () => {
  const body = { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { cost: 0.01, prompt_tokens: 20000, prompt_tokens_details: { cached_tokens: 15000 } } };
  const client = new OpenRouter({ key: 'k', fetch: async () => json(body) });
  const result = await client.complete(args);
  assert.equal(result.promptTokens, 20000);
  assert.equal(result.cachedTokens, 15000);
});

test("the caller's signal cuts the call short and is not retried", async () => {
  let calls = 0;
  const fetch = (url, init) => {
    calls += 1;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const client = new OpenRouter({ key: 'k', fetch, sleep: async () => {} });
  const cut = new AbortController();
  const why = new Error('out of time');
  const pending = client.complete({ ...args, signal: cut.signal });
  cut.abort(why);
  await assert.rejects(pending, (e) => e === why);
  assert.equal(calls, 1);
});
