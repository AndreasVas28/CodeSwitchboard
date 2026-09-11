'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithRetry, parseRetryAfter, RETRYABLE_STATUS } = require('../lib/upstream-fetch');

function json(init, status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers }, ...init });
}

test('retries a rate-limited request every delay period and then succeeds', async () => {
  let requests = 0;
  const pauses = [];
  const response = await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 4,
    delayMs: 5000,
    fetchImpl: async () => {
      requests += 1;
      if (requests < 4) return json({}, 429, { error: { message: 'Rate limit exceeded: 40 requests per minute' } });
      return json({}, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
    sleep: async (ms) => pauses.push(ms),
    log: () => {}
  });
  assert.equal(requests, 4);
  assert.equal(response.status, 200);
  assert.deepEqual(pauses, [5000, 5000, 5000]);
});

test('honors a Retry-After header shorter than the default delay', async () => {
  const pauses = [];
  await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 2,
    delayMs: 5000,
    fetchImpl: async () => json({}, 429, {}, { 'retry-after': '2' }),
    sleep: async (ms) => pauses.push(ms),
    log: () => {}
  });
  assert.deepEqual(pauses, [2000]);
});

test('does not retry non-retryable client errors', async () => {
  let requests = 0;
  const response = await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 5,
    delayMs: 1,
    fetchImpl: async () => { requests += 1; return json({}, 401, { error: { message: 'bad key' } }); },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 1);
  assert.equal(response.status, 401);
});

test('gives up after the attempt cap and reports the last network error', async () => {
  let requests = 0;
  const pauses = [];
  await assert.rejects(
    () => fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
      attempts: 3,
      delayMs: 1,
      fetchImpl: async () => { requests += 1; throw new Error('socket hang up'); },
      sleep: async (ms) => pauses.push(ms),
      log: () => {}
    }),
    /socket hang up/
  );
  assert.equal(requests, 3);
  assert.equal(pauses.length, 2);
});

test('network errors are retried like rate limits', async () => {
  let requests = 0;
  await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 3,
    delayMs: 1,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error('ECONNRESET');
      return json({}, 200, {});
    },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 2);
});

test('retryable status set covers the codes providers use for rate limits', () => {
  for (const status of [429, 503, 504]) assert.ok(RETRYABLE_STATUS.has(status));
  assert.equal(RETRYABLE_STATUS.has(401), false);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
});
