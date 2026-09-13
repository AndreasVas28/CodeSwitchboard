'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithRetry, fetchStreamWithRetry, isRetryableStreamError, parseRetryAfter, RETRYABLE_STATUS } = require('../lib/upstream-fetch');

function sse(...frames) {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const busyFrame = { error: { code: 500, message: 'ResourceExhausted: Worker local total request limit reached (108/32)' } };
const contentFrame = { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered' }, finish_reason: null }] };
const finishFrame = { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

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

test('retries a bare gateway 404 a bounded number of times before passing it through', async () => {
  let requests = 0;
  const pauses = [];
  const response = await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 8,
    delayMs: 5000,
    gateway404Attempts: 2,
    fetchImpl: async () => {
      requests += 1;
      return new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
    sleep: async (ms) => pauses.push(ms),
    log: () => {}
  });
  assert.equal(requests, 3);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '404 page not found');
  assert.deepEqual(pauses, [5000, 5000]);
});

test('recovers when a gateway 404 clears on retry', async () => {
  let requests = 0;
  const response = await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 4,
    delayMs: 5000,
    gateway404Attempts: 3,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) return new Response('404 page not found', { status: 404 });
      return json({}, 200, { ok: true });
    },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 2);
  assert.equal(response.status, 200);
});

test('does not retry a real 404 response body', async () => {
  let requests = 0;
  const response = await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 5,
    delayMs: 1,
    fetchImpl: async () => {
      requests += 1;
      return json({}, 404, { error: { message: 'unknown model' } });
    },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 1);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes('unknown model'));
});

test('includes the request target in retry logs', async () => {
  const logged = [];
  await fetchWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 2,
    delayMs: 1,
    fetchImpl: async () => json({}, 429, {}),
    sleep: async () => {},
    log: (info) => logged.push(info)
  });
  assert.equal(logged[0].target, '/v1/chat/completions');
});

test('retries a 200 stream whose first frame reports a busy worker', async () => {
  let requests = 0;
  const pauses = [];
  const result = await fetchStreamWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 3,
    delayMs: 5000,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) return sse(busyFrame);
      return sse(contentFrame, finishFrame);
    },
    sleep: async (ms) => pauses.push(ms),
    log: () => {}
  });
  assert.equal(requests, 2);
  assert.deepEqual(pauses, [5000]);
  assert.ok(result.head.toString().includes('recovered'));
});

test('hands a healthy stream to the caller on the first attempt', async () => {
  let requests = 0;
  const result = await fetchStreamWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 3,
    delayMs: 5000,
    fetchImpl: async () => { requests += 1; return sse(contentFrame, finishFrame); },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 1);
  assert.ok(result.head.toString().includes('recovered'));
});

test('does not resend a stream that fails after content already arrived', async () => {
  let requests = 0;
  const result = await fetchStreamWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 3,
    delayMs: 1,
    fetchImpl: async () => {
      requests += 1;
      return sse(contentFrame, { error: { code: 500, message: 'ResourceExhausted' } });
    },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 1);
  assert.ok(result.head.toString().includes('recovered'));
});

test('does not resend a malformed-request error delivered inside the stream', async () => {
  let requests = 0;
  await fetchStreamWithRetry('https://provider.test/v1/chat/completions', { method: 'POST' }, {
    attempts: 3,
    delayMs: 1,
    fetchImpl: async () => { requests += 1; return sse({ error: { code: 400, message: 'Invalid tool schema' } }); },
    sleep: async () => {},
    log: () => {}
  });
  assert.equal(requests, 1);
});

test('classifies stream errors as retryable only when the provider is busy', () => {
  assert.equal(isRetryableStreamError(busyFrame.error), true);
  assert.equal(isRetryableStreamError({ code: 503 }), true);
  assert.equal(isRetryableStreamError({ code: 400, message: 'Invalid request' }), false);
});

test('retryable status set covers the codes providers use for rate limits', () => {
  for (const status of [429, 503, 504]) assert.ok(RETRYABLE_STATUS.has(status));
  assert.equal(RETRYABLE_STATUS.has(401), false);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
});
