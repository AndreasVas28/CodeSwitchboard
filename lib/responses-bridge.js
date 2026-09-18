'use strict';
const http = require('http');
const { randomUUID } = require('crypto');
const { fetchStreamWithRetry } = require('./upstream-fetch');

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => ['input_text', 'output_text', 'text'].includes(p.type)).map((p) => p.text || '').join('\n');
}
// Codex's special tools have no OpenAI-hosted implementation on third-party
// providers, but they can be expressed as plain function calls: the provider
// model emits the action, Codex executes it locally and sends the result back.
const LOCAL_SHELL_FUNCTION_NAME = 'local_shell';
const LOCAL_SHELL_PARAMETERS = {
  type: 'object',
  properties: { command: { type: 'array', items: { type: 'string' }, description: 'The command and its arguments, as separate words.' } },
  required: ['command'],
  additionalProperties: false
};
const CUSTOM_TOOL_PARAMETERS = {
  type: 'object',
  properties: { input: { type: 'string', description: 'The freeform input for this tool.' } },
  required: ['input'],
  additionalProperties: false
};
function convertInput(input = []) {
  return input.map((item) => {
    if (item.type === 'function_call_output') return { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) };
    if (item.type === 'function_call') return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] };
    if (item.type === 'local_shell_call_output') return { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) };
    if (item.type === 'local_shell_call') return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: LOCAL_SHELL_FUNCTION_NAME, arguments: JSON.stringify(item.action || {}) } }] };
    if (item.type === 'custom_tool_call_output') return { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) };
    if (item.type === 'custom_tool_call') return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name || 'custom_tool', arguments: JSON.stringify({ input: item.input || '' }) } }] };
    if (item.role) return { role: item.role === 'developer' ? 'system' : item.role, content: textFromContent(item.content) };
    return null;
  }).filter(Boolean);
}
function convertTools(tools = []) {
  const converted = [];
  for (const tool of tools) {
    if (tool.type === 'function') converted.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || {}, strict: tool.strict } });
    else if (tool.type === 'local_shell') converted.push({ type: 'function', function: { name: LOCAL_SHELL_FUNCTION_NAME, description: "Run a shell command on the user's computer and return its output.", parameters: LOCAL_SHELL_PARAMETERS } });
    else if (tool.type === 'custom') converted.push({ type: 'function', function: { name: tool.name || 'custom_tool', description: tool.description || 'A freeform tool.', parameters: CUSTOM_TOOL_PARAMETERS } });
  }
  return converted;
}
// Which Responses item type each declared tool maps back to, so streamed
// function calls can be re-expressed in the dialect the client expects.
function toolKinds(tools = []) {
  const kinds = new Map();
  for (const tool of tools) {
    if (tool.type === 'local_shell') kinds.set(LOCAL_SHELL_FUNCTION_NAME, 'local_shell');
    else if (tool.type === 'custom' && tool.name) kinds.set(tool.name, 'custom');
  }
  return kinds;
}
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }

// The upstream stream was already validated before anything reached the CLI,
// but `head` holds the bytes peeked while doing so — replay them before the
// live reader.
async function* streamChunks(upstream) {
  if (upstream.head?.length) yield upstream.head;
  if (!upstream.reader) return;
  while (true) {
    const { done, value } = await upstream.reader.read();
    if (done) return;
    yield value;
  }
}

// A provider that dies mid-stream cannot simply be resent (the CLI already has
// part of the answer), so report it as a Responses failure the client can show.
// Closing the stream silently is what makes Codex print "stream disconnected
// before completion" with no explanation of what went wrong.
function failStream(res, responseId, model, error) {
  const message = error.message || JSON.stringify(error);
  const code = error.code || error.type || error.status || 'upstream_error';
  res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code, message })}\n\n`);
  event(res, 'response.failed', { response: { id: responseId, object: 'response', status: 'failed', model, error: { code, message } } });
  res.end();
}

function retryOptions(options) {
  const keys = ['attempts', 'delayMs', 'gateway404Attempts'];
  const picked = {};
  for (const key of keys) if (options?.[key] !== undefined) picked[key] = options[key];
  return picked;
}

// Providers answer some failures with an opaque body ("404 page not found",
// HTML, empty). Wrap those so the CLI shows the model and the fix instead of a
// bare gateway string. Known model-gone answers (410) are forwarded untouched.
async function upstreamErrorPayload(upstream, model) {
  const raw = await upstream.text().catch(() => '');
  let detail = raw;
  if (!detail.trim() || detail.trim().startsWith('<')) detail = '';
  if (upstream.status === 404 && !detail) detail = 'The provider has no endpoint or model for this request.';
  let hint = '';
  if (upstream.status === 404) hint = ` The model '${model}' may be unknown to the provider; pick another model and relaunch.`;
  if (upstream.status === 410) hint = ' This model has been retired by the provider; pick another model and relaunch.';
  if (upstream.status === 401 || upstream.status === 403) hint = ' The provider rejected the API key.';
  return {
    error: {
      type: 'upstream_error',
      code: upstream.status,
      message: `Provider returned ${upstream.status} for model '${model}'.${hint}${detail ? ` Provider said: ${detail.slice(0, 300)}` : ''}`
    }
  };
}

function localModelId(model, options) {
  let value = String(model || '');
  value = value.replace(/^codeswitchboard\//i, '').replace(/^openai\//i, '');
  const providerPrefix = options.providerName ? `${options.providerName}/` : '';
  return providerPrefix && value.startsWith(providerPrefix) ? value.slice(providerPrefix.length) : value;
}

// CLIs sometimes send a model the routed provider has never heard of — for
// example Codex's in-app picker listing OpenAI-native names while the session
// still runs through a provider bridge. Forwarding such a model only earns a
// gateway 404, so remap it to the model the provider was launched with (the
// dashboard's pick) and say so in the log.
function resolveUpstreamModel(requested, options) {
  const model = localModelId(requested, options);
  if (!options.model) return model;
  const known = new Set([...(options.models || []), options.model].filter(Boolean).map((id) => localModelId(id, options)));
  if (!known.size || known.has(model)) return model;
  console.warn(`[bridge] model '${model}' is not in the routed catalog; using '${options.model}' instead`);
  return options.model;
}

async function handleChatCompletions(req, res, options) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400).end('Invalid JSON'); return; }
  body.model = resolveUpstreamModel(body.model, options);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') { headers['HTTP-Referer'] = 'https://localhost'; headers['X-Title'] = 'CodeSwitchboard'; }
  const upstream = await fetchStreamWithRetry(`${options.upstreamBaseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, retryOptions(options));
  if (!upstream.response.ok) {
    res.writeHead(upstream.response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await upstreamErrorPayload(upstream.response, body.model)));
    return;
  }
  res.writeHead(upstream.response.status, {
    'content-type': upstream.response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache'
  });
  if (upstream.head?.length) res.write(upstream.head);
  if (!upstream.reader) { res.end(); return; }
  while (true) {
    const { done, value } = await upstream.reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// Codex expects its special tools to come back in their own item dialects
// (local_shell_call with an action object, custom_tool_call with a string
// input), while the provider streams plain function-call arguments. These
// helpers translate one to the other.
function parseShellAction(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed.type ? parsed : { type: 'exec', command: parsed.command || [] };
    }
  } catch { /* fall through to a raw command */ }
  return { type: 'exec', command: [String(raw || '')] };
}
function parseCustomInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.input === 'string') return parsed.input;
  } catch { /* not JSON: the raw text is the input */ }
  return String(raw || '');
}
function toolCallItem(call, status) {
  if (call.kind === 'local_shell') {
    return { id: call.id, call_id: call.call_id, type: 'local_shell_call', status, action: status === 'completed' ? parseShellAction(call.arguments) : { type: 'exec', command: [] } };
  }
  if (call.kind === 'custom') {
    return { id: call.id, call_id: call.call_id, type: 'custom_tool_call', status, name: call.name, input: status === 'completed' ? parseCustomInput(call.arguments) : '' };
  }
  return { id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments, type: 'function_call', status };
}

async function handleResponses(req, res, options) {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end('Invalid JSON'); return; }
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const messages = convertInput(Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input || '' }]);
  if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });
  const request = { model: resolveUpstreamModel(body.model, options), messages, stream: true, tools: convertTools(body.tools), tool_choice: body.tool_choice || 'auto' };
  if (!request.tools.length) { delete request.tools; delete request.tool_choice; }
  const toolKindsByFunctionName = toolKinds(body.tools || []);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') { headers['HTTP-Referer'] = 'https://localhost'; headers['X-Title'] = 'CodeSwitchboard'; }
  const upstream = await fetchStreamWithRetry(`${options.upstreamBaseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(request) }, retryOptions(options));
  if (!upstream.response.ok) { res.writeHead(upstream.response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(await upstreamErrorPayload(upstream.response, request.model))); return; }
  const isEventStream = /text\/event-stream/i.test(upstream.response.headers.get('content-type') || '');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  event(res, 'response.created', { response: { id: responseId, object: 'response', status: 'in_progress', model: request.model, output: [] } });
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
  let messageAdded = false, text = '', buffer = '', usage = null, nextOutputIndex = 0, messageOutputIndex = -1;
  let sawFinish = false, sawDone = false, streamError = null;
  const calls = new Map(); const decoder = new TextDecoder();
  async function* guarded() {
    try { yield* streamChunks(upstream); } catch (error) { streamError = error; }
  }
  for await (const value of guarded()) {
    buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim(); if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim(); if (!payload) continue;
      if (payload === '[DONE]') { sawDone = true; continue; }
      let data; try { data = JSON.parse(payload); } catch { continue; }
      if (data.error) { failStream(res, responseId, request.model, data.error); return; }
      if (data.usage) usage = data.usage;
      const choice = data.choices?.[0] || {};
      if (choice.finish_reason) sawFinish = true;
      const delta = choice.delta || {};
      if (delta.content) {
        if (!messageAdded) {
          messageOutputIndex = nextOutputIndex++;
          event(res, 'response.output_item.added', { output_index: messageOutputIndex, item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
          event(res, 'response.content_part.added', { item_id: messageId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }); messageAdded = true;
        }
        text += delta.content; event(res, 'response.output_text.delta', { item_id: messageId, output_index: messageOutputIndex, content_index: 0, delta: delta.content });
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0;
        if (!calls.has(index)) {
          const name = part.function?.name || '';
          const call = { id: `fc_${randomUUID().replace(/-/g, '')}`, call_id: part.id || `call_${randomUUID().replace(/-/g, '')}`, name, arguments: '', output_index: nextOutputIndex++, kind: toolKindsByFunctionName.get(name) || 'function' }; calls.set(index, call);
          event(res, 'response.output_item.added', { output_index: call.output_index, item: toolCallItem(call, 'in_progress') });
        }
        const call = calls.get(index); if (part.id) call.call_id = part.id; if (part.function?.name) { call.name = part.function.name; call.kind = toolKindsByFunctionName.get(call.name) || call.kind; }
        // Arguments are only streamed to the client for plain function tools;
        // local_shell/custom items carry their payload in the completed item.
        if (call.kind === 'function' && part.function?.arguments) { call.arguments += part.function.arguments; event(res, 'response.function_call_arguments.delta', { item_id: call.id, output_index: call.output_index, delta: part.function.arguments }); }
        else if (part.function?.arguments) call.arguments += part.function.arguments;
      }
    }
  }
  if (streamError) { failStream(res, responseId, request.model, { code: 502, message: `The provider connection dropped mid-answer (${streamError.message}). Send the message again to retry.` }); return; }
  if (isEventStream && !sawFinish && !sawDone) { failStream(res, responseId, request.model, { code: 502, message: `The provider stopped streaming before finishing the answer for model '${request.model}'. Send the message again to retry.` }); return; }
  const output = [];
  const completed = [];
  if (messageAdded) {
    completed.push({ output_index: messageOutputIndex, run: () => {
      event(res, 'response.output_text.done', { item_id: messageId, output_index: messageOutputIndex, content_index: 0, text });
      event(res, 'response.content_part.done', { item_id: messageId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      const item = { id: messageId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
      event(res, 'response.output_item.done', { output_index: messageOutputIndex, item }); output.push(item);
    } });
  }
  for (const call of calls.values()) {
    completed.push({ output_index: call.output_index, run: () => {
      if (call.kind === 'function') event(res, 'response.function_call_arguments.done', { item_id: call.id, output_index: call.output_index, arguments: call.arguments });
      const item = toolCallItem(call, 'completed'); event(res, 'response.output_item.done', { output_index: call.output_index, item }); output.push(item);
    } });
  }
  completed.sort((left, right) => left.output_index - right.output_index).forEach((entry) => entry.run());
  event(res, 'response.completed', { response: { id: responseId, object: 'response', status: 'completed', model: request.model, output, usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } : null } }); res.end();
}

function startBridge(options) {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer(async (req, res) => {
      if (options.localToken && req.url?.startsWith('/v1/') && req.headers.authorization !== `Bearer ${options.localToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Use the local CodeSwitchboard credential.' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
        const models = [...new Set([...(options.models || []), options.model].filter(Boolean))].sort();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: options.providerName || 'codeswitchboard' })) }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) { requestCount += 1; try { await handleResponses(req, res, options); } catch (error) { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); } return; }
      if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) { requestCount += 1; try { await handleChatCompletions(req, res, options); } catch (error) { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); } return; }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `This CodeSwitchboard bridge has no route for ${req.method} ${req.url}. Codex should call /v1/responses or /v1/chat/completions.` } }));
    });
    // Prefer the requested port; if it is taken (a previous bridge that
    // outlived its launcher), fall back to an available one instead of failing
    // the launch. The chosen port is written to the state file so the config
    // overlay always points at the live bridge.
    const listen = (port) => new Promise((resolvePort, rejectPort) => {
      const onError = (error) => {
        if (port && error.code === 'EADDRINUSE') resolvePort(listen(0));
        else rejectPort(error);
      };
      const onListening = () => {
        resolvePort({ port: server.address().port, requestCount: () => requestCount, close: (callback) => server.close(callback) });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port || 0, '127.0.0.1');
    });
    listen(options.port || 0).then(resolve, reject);
  });
}
module.exports = { startBridge, convertInput, convertTools };
