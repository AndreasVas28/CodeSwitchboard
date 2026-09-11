'use strict';

// Upstream providers such as NVIDIA cap requests per minute (about 40 for the
// public API). Inference calls that fail with a rate-limit or transient server
// error are safe to resend because nothing has been streamed yet, so every
// bridge retries here instead of surfacing "high demand" or a dropped stream
// to the CLI on the first failure.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRY_AFTER_MAX_MS = 30_000;

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

async function fetchWithRetry(url, init = {}, options = {}) {
  const attempts = options.attempts ?? envInt('CODESWITCHBOARD_RETRY_ATTEMPTS', 12);
  const delayMs = options.delayMs ?? envInt('CODESWITCHBOARD_RETRY_DELAY_MS', 5000);
  const fetchImpl = options.fetchImpl || fetch;
  const pause = options.sleep || sleep;
  const log = options.log || ((info) => console.warn('[upstream] retrying request', info));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      log({ attempt, attempts, delayMs, reason: error.message });
      await pause(delayMs);
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= attempts) return response;
    const wait = parseRetryAfter(response.headers.get('retry-after')) ?? delayMs;
    try { await response.text(); } catch { /* retryable status bodies are disposable */ }
    log({ attempt, attempts, status: response.status, delayMs: wait });
    await pause(wait);
  }
  throw lastError || new Error('The upstream request failed after retries.');
}

module.exports = { fetchWithRetry, parseRetryAfter, RETRYABLE_STATUS };
