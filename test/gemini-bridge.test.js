'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startGeminiBridge, convertContents, convertTools } = require('../lib/gemini-bridge');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('converts Gemini contents and tools to OpenAI chat format', () => {
  assert.deepEqual(convertContents([
    { role: 'model', parts: [{ text: 'Checking' }, { functionCall: { id: 'call_1', name: 'read', args: { path: 'x' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'read', response: { result: 'done' } } }, { text: 'continue' }] }
  ], { parts: [{ text: 'Be useful' }] }), [
    { role: 'system', content: 'Be useful' },
    { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] },
    { role: 'user', content: 'continue' },
    { role: 'tool', tool_call_id: 'call_1', content: '{"result":"done"}' }
  ]);
  assert.equal(convertTools([{ functionDeclarations: [{ name: 'read', parameters: { type: 'object' } }] }])[0].function.name, 'read');
});

test('serves a Gemini stream backed by OpenAI chat completions', async (context) => {
  let upstreamRequest;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    upstreamRequest = { url: request.url, auth: request.headers.authorization, body: JSON.parse(raw) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"GEMINI_"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startGeminiBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'provider-secret', providerName: 'test', model: 'test/code-model'
  });
  context.after(async () => { await new Promise((resolve) => bridge.close(resolve)); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1beta/models/test%2Fcode-model:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'codeswitchboard-local' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Be concise' }] }, contents: [{ role: 'user', parts: [{ text: 'say ok' }] }] })
  });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.equal(upstreamRequest.url, '/v1/chat/completions');
  assert.equal(upstreamRequest.auth, 'Bearer provider-secret');
  assert.equal(upstreamRequest.body.messages[0].content, 'Be concise');
  assert.match(stream, /GEMINI_OK/);
  assert.match(stream, /"finishReason":"STOP"/);
});
