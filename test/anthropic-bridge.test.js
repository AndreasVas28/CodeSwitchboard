'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const {
  startAnthropicBridge,
  convertMessages,
  convertTools,
  mapStopReason
} = require('../lib/anthropic-bridge');
const { createClaudeProxyEnv, resolveTargetExecutable } = require('../lib/target-registry');

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('converts Anthropic messages and tools to OpenAI chat format', () => {
  assert.deepEqual(convertMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'done' }, { type: 'text', text: 'continue' }] }
  ], [{ type: 'text', text: 'Be useful' }]), [
    { role: 'system', content: 'Be useful' },
    { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'tool_1', content: 'done' },
    { role: 'user', content: 'continue' }
  ]);
  assert.equal(convertTools([{ name: 'read', input_schema: { type: 'object' } }])[0].function.name, 'read');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
});

test('serves an Anthropic Messages stream backed by OpenAI chat completions', async (context) => {
  let upstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamRequest = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"INTEGRATION_"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAnthropicBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'provider-secret',
    providerName: 'test',
    model: 'test/code-model'
  });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'codeswitchboard-local' },
    body: JSON.stringify({ model: 'test/code-model', max_tokens: 100, stream: true, system: 'Be concise', messages: [{ role: 'user', content: 'say ok' }] })
  });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.equal(upstreamRequest.url, '/v1/chat/completions');
  assert.equal(upstreamRequest.auth, 'Bearer provider-secret');
  assert.equal(upstreamRequest.body.messages[0].content, 'Be concise');
  assert.match(stream, /event: message_start/);
  assert.match(stream, /INTEGRATION_/);
  assert.match(stream, /event: message_stop/);
});

test('routes desktop-app model choices through the configured model', async (context) => {
  let forwardedModel;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    forwardedModel = JSON.parse(raw).model;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: forwardedModel, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAnthropicBridge({ upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k', providerName: 'test', model: 'vendor/routed-model' });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 200);
  // Explicit picker/conversation model IDs must pass through unchanged.
  assert.equal(forwardedModel, 'claude-sonnet-4-5');
});

test('routes a Claude-safe desktop picker alias to its provider model', async (context) => {
  let forwardedModel;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    forwardedModel = JSON.parse(raw).model;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAnthropicBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k', providerName: 'test',
    model: 'vendor/model-a', models: ['vendor/model-a', 'vendor/model-b']
  });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-codeswitchboard-5489315e6645', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 200);
  assert.equal(forwardedModel, 'vendor/model-b');
});

test('real Claude Code uses the local Anthropic bridge without login', { timeout: 60_000 }, async (context) => {
  const claude = resolveTargetExecutable({ kind: 'cli', command: 'claude' });
  if (!claude) {
    context.skip('Claude Code is not installed.');
    return;
  }
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"INTEGRATION_OK"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAnthropicBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'provider-secret',
    providerName: 'test',
    model: 'test/code-model'
  });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const env = createClaudeProxyEnv(process.env, `http://127.0.0.1:${bridge.port}`, 'test/code-model');
  const result = await new Promise((resolve, reject) => {
    const cliArgs = [
      '--print', '--output-format', 'text', '--permission-mode', 'default',
      '--model', 'test/code-model', 'Reply with exactly INTEGRATION_OK'
    ];
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `& ${psQuote(claude)} ${cliArgs.map(psQuote).join(' ')}`], { cwd: path.resolve('.'), env, windowsHide: true })
      : spawn(claude, cliArgs, { cwd: path.resolve('.'), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /INTEGRATION_OK/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /not logged in|\/login/i);
});

test('real Claude Code completes a provider-routed tool call', { timeout: 60_000 }, async (context) => {
  const claude = resolveTargetExecutable({ kind: 'cli', command: 'claude' });
  if (!claude) {
    context.skip('Claude Code is not installed.');
    return;
  }
  let requests = 0;
  let sawToolResult = false;
  const upstream = http.createServer(async (req, res) => {
    // Handle model catalog queries from the bridge
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'test/code-model' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests += 1;
    sawToolResult ||= body.messages.some((message) => message.role === 'tool' && /TOOL_OK/.test(message.content));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!sawToolResult) {
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_codeswitchboard_test","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"echo TOOL_OK\\",\\"description\\":\\"Print test marker\\"}"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    } else {
      res.write('data: {"choices":[{"delta":{"content":"TOOL_FLOW_OK"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAnthropicBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'provider-secret', providerName: 'test', model: 'test/code-model'
  });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const env = createClaudeProxyEnv(process.env, `http://127.0.0.1:${bridge.port}`, 'test/code-model');
  const result = await new Promise((resolve, reject) => {
    const cliArgs = [
      '--print', '--output-format', 'text', '--permission-mode', 'default',
      '--allowedTools', 'Bash(echo *)', '--model', 'test/code-model',
      'Use the Bash tool once, then report the result.'
    ];
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `& ${psQuote(claude)} ${cliArgs.map(psQuote).join(' ')}`], { cwd: path.resolve('.'), env, windowsHide: true })
      : spawn(claude, cliArgs, { cwd: path.resolve('.'), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(sawToolResult, true, `Requests: ${requests}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TOOL_FLOW_OK/);
});
