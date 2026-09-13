'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { convertInput, convertTools, startBridge } = require('../lib/responses-bridge');

test('converts Responses messages', () => {
  assert.deepEqual(convertInput([{ role: 'developer', content: [{ type: 'input_text', text: 'Be concise' }] }, { type: 'function_call_output', call_id: 'call_1', output: 'done' }]), [{ role: 'system', content: 'Be concise' }, { role: 'tool', tool_call_id: 'call_1', content: 'done' }]);
});
test('converts function declarations', () => {
  assert.equal(convertTools([{ type: 'function', name: 'shell', parameters: { type: 'object' } }])[0].function.name, 'shell');
});

function parseSseEvents(text) {
  return [...text.matchAll(/data: (\{.*?\})\n\n/g)].map((match) => JSON.parse(match[1]));
}

test('requires the loopback credential and strips the provider model prefix', async (context) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    received = { headers: request.headers, body: JSON.parse(raw) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'upstream-secret', providerName: 'nvidia', localToken: 'codeswitchboard-local' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const unauthorized = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nvidia/vendor/model-a', messages: [] }) });
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer codeswitchboard-local' }, body: JSON.stringify({ model: 'codeswitchboard/nvidia/vendor/model-a', messages: [] }) });
  assert.equal(response.status, 200);
  assert.equal(received.body.model, 'vendor/model-a');
  assert.equal(received.headers.authorization, 'Bearer upstream-secret');
});

test('lists configured models for model discovery', async (context) => {
  const bridge = await startBridge({ port: 0, upstreamBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', providerName: 'test', models: ['test/model-b', 'test/model-a', 'test/model-b'] });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/models`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data.map((model) => model.id), ['test/model-a', 'test/model-b']);
});

test('falls back to the selected model when no model list is configured', async (context) => {
  const bridge = await startBridge({ port: 0, upstreamBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', providerName: 'test', model: 'test/fallback' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/models`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data.map((model) => model.id), ['test/fallback']);
});

test('retries upstream rate limits instead of failing the request', async (context) => {
  let upstreamRequests = 0;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    upstreamRequests += 1;
    if (upstreamRequests === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'test', model: 'test/model' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'recovered');
  assert.equal(upstreamRequests, 2);
});

test('wraps opaque upstream failures with the model and next step', async (context) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('404 page not found');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'nvidia', model: 'test/model', gateway404Attempts: 0 });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia/test/model', input: 'hi' })
  });
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error.code, 404);
  assert.ok(payload.error.message.includes("'test/model'"));
  assert.ok(payload.error.message.includes('pick another model'));
});

test('the fallback 404 identifies the bridge and available routes', async (context) => {
  const bridge = await startBridge({ port: 0, upstreamBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', providerName: 'test', model: 'test/model' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/nope`);
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.ok(payload.error.message.includes('CodeSwitchboard bridge'));
  assert.ok(payload.error.message.includes('/v1/responses'));
});

test('remaps models the routed provider does not know to the routed default', async (context) => {
  let receivedModel = null;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    receivedModel = JSON.parse(raw).model;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'nvidia', model: 'routed/default', models: ['routed/default', 'routed/other'] });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-astra', input: 'hi' })
  });
  assert.equal(response.status, 200);
  assert.equal(receivedModel, 'routed/default');
});

test('passes models through untouched when no routed default exists', async (context) => {
  let receivedModel = null;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    receivedModel = JSON.parse(raw).model;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'test', models: ['test/only'] });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'anything/goes', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 200);
  assert.equal(receivedModel, 'anything/goes');
});

test('retries a busy worker reported inside a 200 stream instead of failing the Codex session', async (context) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (upstreamRequests === 1) {
      response.write(`data: ${JSON.stringify({ error: { code: 500, message: 'ResourceExhausted: Worker local total request limit reached (108/32)' } })}\n\n`);
      response.end();
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'nvidia', model: 'test/model', attempts: 3, delayMs: 0 });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test/model', input: 'hi' })
  });
  assert.equal(response.status, 200);
  const events = parseSseEvents(await response.text());

  // The busy-worker frame must never reach the CLI: it was retried upstream.
  assert.equal(events.some((event) => event.type === 'response.failed'), false);
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.output[0].content[0].text, 'recovered');
  assert.equal(upstreamRequests, 2);
});

test('reports a stream that dies mid-answer instead of closing silently', async (context) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'half an ans' }, finish_reason: null }] })}\n\n`);
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'test', model: 'test/model', attempts: 1, delayMs: 0 });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test/model', input: 'hi' })
  });
  const events = parseSseEvents(await response.text());
  const failed = events.find((event) => event.type === 'response.failed');
  assert.ok(failed, 'the stream must end with an explained failure');
  assert.match(failed.response.error.message, /stopped streaming before finishing/);
});

test('a busy requested port falls back to an available one', async (context) => {
  const holder = http.createServer(() => {});
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => holder.close(resolve)));

  const bridge = await startBridge({ port: holder.address().port, upstreamBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', providerName: 'test', model: 'test/model' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  assert.notEqual(bridge.port, holder.address().port);
  const health = await fetch(`http://127.0.0.1:${bridge.port}/health`);
  assert.equal(health.status, 200);
});

test('keeps output indices consistent when tool calls arrive before text', async (context) => {
  const upstream = http.createServer((request, response) => {
    const chunks = [
      { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] },
      { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { id: 'x', choices: [{ index: 0, delta: { content: 'Ran it. ' }, finish_reason: null }] },
      { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridge = await startBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', providerName: 'test', model: 'test/model' });
  context.after(() => new Promise((resolve) => bridge.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test/model', input: 'run ls', tools: [{ type: 'function', name: 'bash' }] })
  });
  assert.equal(response.status, 200);
  const events = parseSseEvents(await response.text());

  const added = events.filter((event) => event.type === 'response.output_item.added');
  const done = events.filter((event) => event.type === 'response.output_item.done');
  const toolAdded = added.find((event) => event.item.type === 'function_call');
  const messageAdded = added.find((event) => event.item.type === 'message');
  const toolDone = done.find((event) => event.item.type === 'function_call');
  const messageDone = done.find((event) => event.item.type === 'message');

  // The tool call arrives first, so it must own output index 0 and the message 1.
  assert.equal(toolAdded.output_index, 0);
  assert.equal(messageAdded.output_index, 1);
  // Every item keeps the same index from announce to completion.
  assert.equal(toolDone.output_index, toolAdded.output_index);
  assert.equal(messageDone.output_index, messageAdded.output_index);
  // Tool argument fragments still accumulate into the completed item.
  assert.equal(toolDone.item.arguments, '{"command":"ls"}');

  const completed = events.find((event) => event.type === 'response.completed');
  assert.deepEqual(completed.response.output.map((item) => [item.type, item.type === 'function_call' ? item.arguments : item.content?.[0]?.text]), [['function_call', '{"command":"ls"}'], ['message', 'Ran it. ']]);
});