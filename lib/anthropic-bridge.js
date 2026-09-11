'use strict';

const http = require('http');
const { createHash, randomUUID } = require('crypto');
const { fetchWithRetry } = require('./upstream-fetch');

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\n\n');
}

function userParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  const parts = [];
  for (const part of content) {
    if (part?.type === 'text') parts.push({ type: 'text', text: part.text || '' });
    if (part?.type === 'image') {
      const source = part.source || {};
      const url = source.type === 'base64'
        ? `data:${source.media_type || 'application/octet-stream'};base64,${source.data || ''}`
        : source.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('\n');
  return parts;
}

function toolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((part) => part?.type === 'text' ? part.text || '' : JSON.stringify(part)).join('\n');
}

function convertMessages(messages = [], system) {
  const converted = [];
  const systemText = textContent(system);
  if (systemText) converted.push({ role: 'system', content: systemText });

  for (const message of messages) {
    const content = message?.content;
    if (message?.role === 'assistant') {
      if (typeof content === 'string') {
        converted.push({ role: 'assistant', content });
        continue;
      }
      const text = [];
      const toolCalls = [];
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === 'text') text.push(part.text || '');
        if (part?.type === 'thinking' && part.thinking) text.push(`<think>\n${part.thinking}\n</think>`);
        if (part?.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
          });
        }
      }
      const result = { role: 'assistant', content: text.join('\n\n') };
      if (toolCalls.length) result.tool_calls = toolCalls;
      converted.push(result);
      continue;
    }

    if (message?.role !== 'user') continue;
    if (typeof content === 'string') {
      converted.push({ role: 'user', content });
      continue;
    }
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      converted.push({ role: 'user', content: userParts(pending) });
      pending = [];
    };
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'tool_result') {
        flush();
        converted.push({ role: 'tool', tool_call_id: part.tool_use_id, content: toolResultContent(part.content) });
      } else if (['text', 'image'].includes(part?.type)) {
        pending.push(part);
      }
    }
    flush();
  }
  return converted;
}

function convertTools(tools = []) {
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
}

function convertToolChoice(choice) {
  if (!choice) return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return 'auto';
}

function chatRequest(body, stream) {
  const request = {
    model: body.model,
    messages: convertMessages(body.messages, body.system),
    max_tokens: body.max_tokens,
    stream,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: convertTools(body.tools),
    tool_choice: convertToolChoice(body.tool_choice)
  };
  if (!request.tools.length) {
    delete request.tools;
    delete request.tool_choice;
  }
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined || value === null) delete request[key];
  }
  return request;
}

function anthropicHeaders(options) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') {
    headers['HTTP-Referer'] = 'https://localhost';
    headers['X-Title'] = 'CodeSwitchboard';
  }
  return headers;
}

function formatEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapStopReason(reason, hasTools = false) {
  if (hasTools || reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop') return 'end_turn';
  return 'end_turn';
}

function anthropicMessage(data, requestedModel) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = { raw: call.function?.arguments || '' }; }
    content.push({ type: 'tool_use', id: call.id || `toolu_${randomUUID().replaceAll('-', '')}`, name: call.function?.name || '', input });
  }
  return {
    id: data.id?.startsWith('msg_') ? data.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestedModel,
    stop_reason: mapStopReason(choice.finish_reason, Boolean(message.tool_calls?.length)),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0
    }
  };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function forwardNonStreaming(body, res, options) {
  const request = chatRequest(body, false);
  const upstream = await fetchWithRetry(`${options.upstreamBaseUrl}/chat/completions`, {
    method: 'POST', headers: anthropicHeaders(options), body: JSON.stringify(request)
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error('[anthropic-bridge] upstream request failed', { status: upstream.status, model: request.model });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(raw);
    return;
  }
  const result = anthropicMessage(JSON.parse(raw), body.model);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function forwardStreaming(body, res, options) {
  const request = chatRequest(body, true);
  const upstream = await fetchWithRetry(`${options.upstreamBaseUrl}/chat/completions`, {
    method: 'POST', headers: anthropicHeaders(options), body: JSON.stringify(request)
  });
  if (!upstream.ok) {
    console.error('[anthropic-bridge] upstream streaming request failed', { status: upstream.status, model: request.model });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  res.write(formatEvent('message_start', {
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1 } }
  }));

  let buffer = '';
  let nextBlock = 0;
  let openText = null;
  let finishReason = null;
  let usage = null;
  let outputChars = 0;
  const calls = new Map();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const closeText = () => {
    if (openText === null) return;
    res.write(formatEvent('content_block_stop', { type: 'content_block_stop', index: openText }));
    openText = null;
  };
  const ensureText = () => {
    if (openText !== null) return openText;
    openText = nextBlock++;
    res.write(formatEvent('content_block_start', { type: 'content_block_start', index: openText, content_block: { type: 'text', text: '' } }));
    return openText;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.usage) usage = data.usage;
      const choice = data.choices?.[0] || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        const index = ensureText();
        outputChars += delta.content.length;
        res.write(formatEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } }));
      }
      for (const part of delta.tool_calls || []) {
        closeText();
        const toolIndex = part.index ?? 0;
        if (!calls.has(toolIndex)) {
          const call = {
            block: nextBlock++,
            id: part.id || `toolu_${randomUUID().replaceAll('-', '')}`,
            name: part.function?.name || '',
            arguments: '',
            started: false
          };
          calls.set(toolIndex, call);
        }
        const call = calls.get(toolIndex);
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name.startsWith(call.name) ? part.function.name.slice(call.name.length) : part.function.name;
        if (!call.started && call.name) {
          res.write(formatEvent('content_block_start', { type: 'content_block_start', index: call.block, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
          call.started = true;
        }
        if (part.function?.arguments) {
          call.arguments += part.function.arguments;
          outputChars += part.function.arguments.length;
          if (!call.started) {
            res.write(formatEvent('content_block_start', { type: 'content_block_start', index: call.block, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
            call.started = true;
          }
          res.write(formatEvent('content_block_delta', { type: 'content_block_delta', index: call.block, delta: { type: 'input_json_delta', partial_json: part.function.arguments } }));
        }
      }
    }
  }
  closeText();
  for (const call of calls.values()) {
    if (!call.started) {
      res.write(formatEvent('content_block_start', { type: 'content_block_start', index: call.block, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
    }
    res.write(formatEvent('content_block_stop', { type: 'content_block_stop', index: call.block }));
  }
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || Math.max(1, Math.ceil(outputChars / 4));
  res.write(formatEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(finishReason, calls.size > 0), stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }));
  res.write(formatEvent('message_stop', { type: 'message_stop' }));
  res.end();
}

function estimateTokens(body) {
  const text = [textContent(body.system), ...((body.messages || []).map((message) => textContent(message.content)))].join('\n');
  return Math.max(1, Math.ceil(text.length / 4));
}

function modelCatalog(models) {
  const ids = [...new Set((Array.isArray(models) ? models : [models]).filter(Boolean))];
  const data = ids.map((model) => ({
    type: 'model',
    id: model,
    display_name: model
  }));
  return { type: 'list', data };
}

function claudeDesktopModelEntries(models) {
  const ids = [...new Set((Array.isArray(models) ? models : [models]).filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim()))];
  return ids.slice(0, 200).map((model) => ({
    name: `claude-codeswitchboard-${createHash('sha256').update(model).digest('hex').slice(0, 12)}`,
    labelOverride: model
  }));
}

function startAnthropicBridge(options) {
  const configuredModels = [...new Set([options.model, ...(options.models || [])].filter(Boolean))];
  const desktopEntries = claudeDesktopModelEntries(configuredModels);
  const modelByAlias = new Map(desktopEntries.map((entry) => [entry.name, entry.labelOverride]));
  let upstreamModelCache = null;
  let upstreamModelCacheTime = 0;
  let requestCount = 0;
  const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async function fetchUpstreamModels() {
    const now = Date.now();
    if (upstreamModelCache && (now - upstreamModelCacheTime) < MODEL_CACHE_TTL) {
      return upstreamModelCache;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const upstream = await fetch(`${options.upstreamBaseUrl}/models`, {
        headers: anthropicHeaders(options),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!upstream.ok) return null;
      const data = await upstream.json();
      const ids = (data.data || data || []).map((m) => m.id || m).filter(Boolean);
      upstreamModelCache = ids;
      upstreamModelCacheTime = now;
      return ids;
    } catch {
      return null;
    }
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy', model: options.model }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'list', data: desktopEntries.map((entry) => ({ type: 'model', id: entry.name, display_name: entry.labelOverride })) }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
          const body = await readJson(req);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages') {
          requestCount += 1;
          const body = await readJson(req);
          const routedModel = modelByAlias.get(body.model);
          if (routedModel) body.model = routedModel;
          // Preserve an explicitly selected model ID. Claude Desktop may send a
          // model from an older conversation or a provider catalog that is not
          // present in this bridge's startup snapshot; silently replacing it
          // would make the native picker appear broken.
          if (body.stream) await forwardStreaming(body, res, options);
          else await forwardNonStreaming(body, res, options);
          return;
        }
        if (['HEAD', 'OPTIONS'].includes(req.method) && ['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
          res.writeHead(200, { allow: 'POST, HEAD, OPTIONS' }).end();
          return;
        }
        res.writeHead(404).end('Not found');
      } catch (error) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } }));
      }
    });
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requestCount: () => requestCount,
      close: (callback) => server.close(callback)
    }));
  });
}

module.exports = {
  startAnthropicBridge,
  convertMessages,
  convertTools,
  convertToolChoice,
  chatRequest,
  mapStopReason,
  anthropicMessage,
  modelCatalog,
  claudeDesktopModelEntries
};
