'use strict';

// Upstream providers such as NVIDIA cap requests per minute (about 40 for the
// public API). Inference calls that fail with a rate-limit or transient server
// error are safe to resend because nothing has been streamed yet, so every
// bridge retries here instead of surfacing "high demand" or a dropped stream
// to the CLI on the first failure.
//
// Some provider gateways (NVIDIA's included) answer with a bare Go http body
// such as "404 page not found" when a model id is unknown to them. That body
// can also appear transiently while their fleet reshuffles, so it is retried a
// few times before being passed through verbatim.
//
// The nastiest case is a *busy worker reported inside a successful stream*:
// NVIDIA answers HTTP 200 and application/event-stream, then the very first
// SSE frame is
//   {"error":{"message":"ResourceExhausted: Worker local total request limit
//    reached (108/32)"}}
// A status-code retry never sees that, so the CLI is handed a half-open stream
// and reports "stream disconnected before completion: response.failed event
// received". `fetchStreamWithRetry` peeks the head of the upstream stream and
// treats that error exactly like a retryable status, for as long as the
// provider has not produced any content yet (so a retry can never duplicate
// output).

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRY_AFTER_MAX_MS = 30_000;
const GATEWAY_404_BODY = /^\s*404 page not found\s*$/i;
// Busy-provider wording that providers put in in-stream error frames.
const BUSY_STREAM_ERROR = /rate limit|ratelimit|resourceexhausted|resource exhausted|worker local total request limit|overloaded|over capacity|capacity|too many requests|try again|temporarily unavailable|service unavailable/i;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), RETRY_AFTER_MAX_MS));
  return null;
}

function targetOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function cloneResponseWith(response, body) {
  const headers = new Headers();
  for (const [key, value] of response.headers) if (key.toLowerCase() !== 'content-length') headers.set(key, value);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// An in-stream error is worth resending only when the provider is busy or
// broken; a malformed request or a bad model would fail identically forever.
function isRetryableStreamError(error) {
  if (!error) return false;
  const code = Number(error.code);
  if (Number.isFinite(code) && code >= 400) return RETRYABLE_STATUS.has(code) || code >= 500;
  const type = Number(error.status);
  if (Number.isFinite(type) && type >= 500) return true;
  return BUSY_STREAM_ERROR.test(String(error.message || error.type || error.code || ''));
}

function parseFramePayload(frame) {
  const parts = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const value = trimmed.slice(5).trim();
    if (value && value !== '[DONE]') parts.push(value);
  }
  if (!parts.length) return null;
  try { return JSON.parse(parts.join('\n')); } catch { return null; }
}

function frameKind(frame) {
  const dataLines = frame.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
  if (!dataLines.length) return 'ignore';
  if (dataLines.includes('[DONE]')) return 'done';
  const data = parseFramePayload(frame);
  if (!data) return 'ignore';
  if (data.error) return isRetryableStreamError(data.error) ? 'retry' : 'body';
  const choice = data.choices?.[0];
  if (!choice) return 'body';
  const delta = choice.delta || {};
  if (choice.finish_reason) return 'content';
  if (delta.content || delta.tool_calls?.length) return 'content';
  return 'body';
}

// Decide whether the head of an upstream response is safe to hand to the CLI:
// 'retry' means the provider answered "busy" (or closed early) before producing
// anything, 'content' means real output has started, 'pending' means keep
// reading, 'body' means a non-error payload (role announce, usage, JSON body).
function scanStreamHead(buffer, contentType = '') {
  const text = buffer.toString('utf8');
  if (/application\/json/i.test(contentType)) {
    const trimmed = text.trim();
    if (!trimmed) return { verdict: 'retry', sawBody: false };
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { return { verdict: 'pending', sawBody: false }; }
    if (parsed?.error) return { verdict: isRetryableStreamError(parsed.error) ? 'retry' : 'body', sawBody: true };
    return { verdict: 'body', sawBody: true };
  }
  const frames = text.split('\n\n');
  frames.pop(); // the trailing slice may be an incomplete frame
  let sawBody = false;
  for (const frame of frames) {
    const kind = frameKind(frame);
    if (kind === 'content') return { verdict: 'content', sawBody };
    if (kind === 'retry') return { verdict: 'retry', sawBody };
    if (kind === 'done') return { verdict: sawBody ? 'body' : 'retry', sawBody };
    if (kind === 'body') sawBody = true;
  }
  return { verdict: 'pending', sawBody };
}

function streamHeadVerdict(buffer, contentType = '') {
  return scanStreamHead(buffer, contentType).verdict;
}

// Once the provider has closed the stream, a head that only carried non-error
// payloads (a role announce, usage, a JSON body) is all we are going to get, so
// hand it on rather than resending a request that plainly succeeded.
function streamEndVerdict(buffer, contentType = '') {
  const scan = scanStreamHead(buffer, contentType);
  if (scan.verdict === 'pending') return scan.sawBody ? 'body' : 'retry';
  return scan.verdict;
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const attempts = options.attempts ?? envInt('CODESWITCHBOARD_RETRY_ATTEMPTS', 12);
  const delayMs = options.delayMs ?? envInt('CODESWITCHBOARD_RETRY_DELAY_MS', 5000);
  const gateway404Attempts = options.gateway404Attempts ?? envInt('CODESWITCHBOARD_GATEWAY_404_ATTEMPTS', 3);
  const fetchImpl = options.fetchImpl || fetch;
  const pause = options.sleep || sleep;
  const target = targetOf(url);
  const log = options.log || ((info) => console.warn('[upstream] retrying request', info));
  let lastError = null;
  let gateway404Count = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      log({ attempt, attempts, target, delayMs, reason: error.message });
      await pause(delayMs);
      continue;
    }
    if (response.status === 404 && attempt < attempts) {
      const text = await response.text().catch(() => '');
      if (GATEWAY_404_BODY.test(text) && gateway404Count < gateway404Attempts) {
        gateway404Count += 1;
        log({ attempt, attempts, status: 404, target, delayMs, reason: 'gateway 404 (model or path unknown upstream)' });
        await pause(delayMs);
        continue;
      }
      return cloneResponseWith(response, text);
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= attempts) return response;
    const wait = parseRetryAfter(response.headers.get('retry-after')) ?? delayMs;
    try { await response.text(); } catch { /* retryable status bodies are disposable */ }
    log({ attempt, attempts, status: response.status, target, delayMs: wait });
    await pause(wait);
  }
  throw lastError || new Error(`The upstream request to ${target} failed after ${attempts} attempts.`);
}

// Same contract as fetchWithRetry, plus a validated stream head. Resolves with
// { response, reader, head } once the provider has produced content: `head`
// holds the already-consumed bytes (replay them before reading `reader`), so a
// CLI never sees the first frame of a stream that is about to fail.
async function fetchStreamWithRetry(url, init = {}, options = {}) {
  const attempts = options.streamAttempts ?? options.attempts ?? envInt('CODESWITCHBOARD_RETRY_ATTEMPTS', 12);
  const delayMs = options.delayMs ?? envInt('CODESWITCHBOARD_RETRY_DELAY_MS', 5000);
  const maxPeekBytes = options.peekBytes ?? envInt('CODESWITCHBOARD_STREAM_PEEK_BYTES', 65536);
  const pause = options.sleep || sleep;
  const target = targetOf(url);
  const log = options.log || ((info) => console.warn('[upstream] retrying stream', info));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchWithRetry(url, init, options);
    if (!response.ok || !response.body) return { response };
    const contentType = response.headers.get('content-type') || '';
    const reader = response.body.getReader();
    const head = [];
    let verdict = 'pending';
    let reason = '';
    while (verdict === 'pending') {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        verdict = 'retry';
        reason = error.message;
        break;
      }
      if (chunk.done) {
        verdict = streamEndVerdict(Buffer.concat(head), contentType);
        reason = verdict === 'retry' ? 'the provider closed the stream before sending any content' : '';
        break;
      }
      head.push(Buffer.from(chunk.value));
      const buffer = Buffer.concat(head);
      verdict = streamHeadVerdict(buffer, contentType);
      if (verdict === 'pending' && buffer.length >= maxPeekBytes) verdict = 'body';
    }
    if (verdict === 'retry' && attempt < attempts) {
      log({ attempt, attempts, target, delayMs, reason: reason || 'provider reported a busy worker inside the stream' });
      try { await reader.cancel(); } catch { /* nothing to drain */ }
      await pause(delayMs);
      continue;
    }
    return { response, reader, head: Buffer.concat(head), retried: verdict === 'retry' };
  }
  return { response: undefined };
}

module.exports = { fetchWithRetry, fetchStreamWithRetry, isRetryableStreamError, streamHeadVerdict, parseRetryAfter, RETRYABLE_STATUS };
