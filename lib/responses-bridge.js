'use strict';
const http = require('http');
const { randomUUID } = require('crypto');

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => ['input_text', 'output_text', 'text'].includes(p.type)).map((p) => p.text || '').join('\n');
}
function convertInput(input = []) {
  return input.map((item) => {
    if (item.type === 'function_call_output') return { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) };
    if (item.type === 'function_call') return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] };
    if (item.role) return { role: item.role === 'developer' ? 'system' : item.role, content: textFromContent(item.content) };
    return null;
  }).filter(Boolean);
}
function convertTools(tools = []) {
  return tools.filter((tool) => tool.type === 'function').map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || {}, strict: tool.strict } }));
}
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }

function localModelId(model, options) {
  let value = String(model || '');
  value = value.replace(/^codeswitchboard\//i, '').replace(/^openai\//i, '');
  const providerPrefix = options.providerName ? `${options.providerName}/` : '';
  return providerPrefix && value.startsWith(providerPrefix) ? value.slice(providerPrefix.length) : value;
}

async function handleChatCompletions(req, res, options) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400).end('Invalid JSON'); return; }
  body.model = localModelId(body.model, options);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') { headers['HTTP-Referer'] = 'https://localhost'; headers['X-Title'] = 'CodeSwitchboard'; }
  const upstream = await fetch(`${options.upstreamBaseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache'
  });
  if (!upstream.body) { res.end(await upstream.text()); return; }
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handleResponses(req, res, options) {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end('Invalid JSON'); return; }
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const messages = convertInput(Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input || '' }]);
  if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });
  const request = { model: body.model, messages, stream: true, tools: convertTools(body.tools), tool_choice: body.tool_choice || 'auto' };
  if (!request.tools.length) { delete request.tools; delete request.tool_choice; }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') { headers['HTTP-Referer'] = 'https://localhost'; headers['X-Title'] = 'CodeSwitchboard'; }
  const upstream = await fetch(`${options.upstreamBaseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(request) });
  if (!upstream.ok) { res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text()); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  event(res, 'response.created', { response: { id: responseId, object: 'response', status: 'in_progress', model: request.model, output: [] } });
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
  let messageAdded = false, text = '', buffer = '', usage = null, nextOutputIndex = 0, messageOutputIndex = -1;
  const calls = new Map(); const reader = upstream.body.getReader(); const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim(); if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
      let data; try { data = JSON.parse(payload); } catch { continue; }
      if (data.error) {
        const message = data.error.message || JSON.stringify(data.error);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: data.error.code || data.error.type || 'upstream_error', message })}\n\n`);
        event(res, 'response.failed', { response: { id: responseId, object: 'response', status: 'failed', model: request.model, error: { code: data.error.code || data.error.type || 'upstream_error', message } } });
        res.end();
        return;
      }
      if (data.usage) usage = data.usage;
      const delta = data.choices?.[0]?.delta || {};
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
          const call = { id: `fc_${randomUUID().replace(/-/g, '')}`, call_id: part.id || `call_${randomUUID().replace(/-/g, '')}`, name: part.function?.name || '', arguments: '', output_index: nextOutputIndex++ }; calls.set(index, call);
          event(res, 'response.output_item.added', { output_index: call.output_index, item: { id: call.id, call_id: call.call_id, name: call.name, arguments: '', type: 'function_call', status: 'in_progress' } });
        }
        const call = calls.get(index); if (part.id) call.call_id = part.id; if (part.function?.name) call.name = part.function.name;
        if (part.function?.arguments) { call.arguments += part.function.arguments; event(res, 'response.function_call_arguments.delta', { item_id: call.id, output_index: call.output_index, delta: part.function.arguments }); }
      }
    }
  }
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
      event(res, 'response.function_call_arguments.done', { item_id: call.id, output_index: call.output_index, arguments: call.arguments });
      const item = { id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments, type: 'function_call', status: 'completed' }; event(res, 'response.output_item.done', { output_index: call.output_index, item }); output.push(item);
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
      res.writeHead(404).end('Not found');
    });
    server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', () => resolve({ port: server.address().port, requestCount: () => requestCount, close: (callback) => server.close(callback) }));
  });
}
module.exports = { startBridge, convertInput, convertTools };
