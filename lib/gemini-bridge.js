'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function textFromParts(parts = []) {
  return parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n');
}

function userContent(parts = []) {
  const content = [];
  for (const part of parts) {
    if (typeof part?.text === 'string') content.push({ type: 'text', text: part.text });
    if (part?.inlineData?.data) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${part.inlineData.mimeType || 'application/octet-stream'};base64,${part.inlineData.data}` }
      });
    }
  }
  if (content.every((part) => part.type === 'text')) return content.map((part) => part.text).join('\n');
  return content;
}

function convertContents(contents = [], systemInstruction) {
  const messages = [];
  const system = textFromParts(systemInstruction?.parts);
  if (system) messages.push({ role: 'system', content: system });

  for (const content of contents) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    if (content?.role === 'model') {
      const toolCalls = parts.filter((part) => part?.functionCall).map((part) => ({
        id: part.functionCall.id || `call_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name: part.functionCall.name || '', arguments: JSON.stringify(part.functionCall.args || {}) }
      }));
      const message = { role: 'assistant', content: textFromParts(parts) || null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }

    const ordinary = parts.filter((part) => !part?.functionResponse);
    if (ordinary.length) messages.push({ role: 'user', content: userContent(ordinary) });
    for (const part of parts.filter((item) => item?.functionResponse)) {
      const response = part.functionResponse;
      messages.push({
        role: 'tool',
        tool_call_id: response.id || `call_${response.name || 'tool'}`,
        content: typeof response.response === 'string' ? response.response : JSON.stringify(response.response || {})
      });
    }
  }
  return messages;
}

function convertTools(tools = []) {
  return tools.flatMap((group) => (group?.functionDeclarations || []).map((declaration) => ({
    type: 'function',
    function: {
      name: declaration.name,
      description: declaration.description || '',
      parameters: declaration.parametersJsonSchema || declaration.parameters || { type: 'object', properties: {} }
    }
  })));
}

function convertToolChoice(toolConfig = {}) {
  const config = toolConfig.functionCallingConfig || {};
  if (config.mode === 'NONE') return 'none';
  if (config.allowedFunctionNames?.length === 1) {
    return { type: 'function', function: { name: config.allowedFunctionNames[0] } };
  }
  if (config.mode === 'ANY') return 'required';
  return 'auto';
}

function chatRequest(body, model, stream) {
  const generation = body.generationConfig || {};
  const request = {
    model,
    messages: convertContents(body.contents, body.systemInstruction),
    stream,
    temperature: generation.temperature,
    top_p: generation.topP,
    max_tokens: generation.maxOutputTokens,
    stop: generation.stopSequences,
    tools: convertTools(body.tools),
    tool_choice: convertToolChoice(body.toolConfig)
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

function providerHeaders(options) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
  if (options.providerName === 'openrouter') {
    headers['HTTP-Referer'] = 'https://localhost';
    headers['X-Title'] = 'CodeSwitchboard';
  }
  return headers;
}

function finishReason(reason, hasTools) {
  if (reason === 'length') return 'MAX_TOKENS';
  if (reason === 'content_filter') return 'SAFETY';
  return hasTools || reason === 'tool_calls' ? 'STOP' : 'STOP';
}

function geminiResponse({ model, text, calls, finish, usage }) {
  const parts = [];
  if (text) parts.push({ text });
  for (const call of calls.values()) {
    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch { args = { raw: call.arguments || '' }; }
    parts.push({ functionCall: { id: call.id, name: call.name, args } });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason: finishReason(finish, calls.size > 0), index: 0 }],
    usageMetadata: {
      promptTokenCount: usage?.prompt_tokens || 0,
      candidatesTokenCount: usage?.completion_tokens || 0,
      totalTokenCount: usage?.total_tokens || 0
    },
    modelVersion: model,
    responseId: `gem_${randomUUID().replaceAll('-', '')}`
  };
}

async function collectStream(upstream, model) {
  let buffer = '', text = '', finish = null, usage = null;
  const calls = new Map();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
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
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') text += delta.content;
      for (const item of delta.tool_calls || []) {
        const index = item.index ?? 0;
        if (!calls.has(index)) calls.set(index, { id: item.id || `call_${randomUUID().replaceAll('-', '')}`, name: '', arguments: '' });
        const call = calls.get(index);
        if (item.id) call.id = item.id;
        if (item.function?.name) call.name += item.function.name.startsWith(call.name) ? item.function.name.slice(call.name.length) : item.function.name;
        if (item.function?.arguments) call.arguments += item.function.arguments;
      }
    }
  }
  return geminiResponse({ model, text, calls, finish, usage });
}

async function forwardGeneration(request, response, options, model, stream) {
  const body = await readJson(request);
  const upstream = await fetch(`${options.upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: providerHeaders(options),
    body: JSON.stringify(chatRequest(body, model, stream))
  });
  if (!upstream.ok) {
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: upstream.status, message: await upstream.text(), status: 'UPSTREAM_ERROR' } }));
    return;
  }

  let result;
  if (stream) {
    result = await collectStream(upstream, model);
  } else {
    const data = await upstream.json();
    const message = data.choices?.[0]?.message || {};
    const calls = new Map((message.tool_calls || []).map((call, index) => [index, {
      id: call.id || `call_${randomUUID().replaceAll('-', '')}`,
      name: call.function?.name || '',
      arguments: call.function?.arguments || '{}'
    }]));
    result = geminiResponse({ model, text: message.content || '', calls, finish: data.choices?.[0]?.finish_reason, usage: data.usage });
  }

  response.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' });
  response.end(stream ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result));
}

function modelItem(model) {
  return {
    name: `models/${model}`,
    baseModelId: model,
    version: '001',
    displayName: model,
    inputTokenLimit: 262144,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'countTokens']
  };
}

function startGeminiBridge(options) {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'healthy', model: options.model }));
          return;
        }
        if (request.method === 'GET' && /\/v1(?:beta)?\/models\/?$/.test(url.pathname)) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ models: [...new Set([...(options.models || []), options.model].filter(Boolean))].map(modelItem) }));
          return;
        }
        const match = url.pathname.match(/\/v1(?:beta)?\/models\/(.+):(streamGenerateContent|generateContent|countTokens)$/);
        if (request.method === 'POST' && match) {
          const model = decodeURIComponent(match[1]);
          if (match[2] === 'countTokens') {
            const body = await readJson(request);
            const text = (body.contents || []).map((content) => textFromParts(content.parts)).join('\n');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ totalTokens: Math.max(1, Math.ceil(text.length / 4)) }));
            return;
          }
          requestCount += 1;
          await forwardGeneration(request, response, options, model, match[2] === 'streamGenerateContent');
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 404, message: `Unsupported Gemini route: ${url.pathname}`, status: 'NOT_FOUND' } }));
      } catch (error) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 502, message: error.message, status: 'BRIDGE_ERROR' } }));
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

module.exports = { startGeminiBridge, convertContents, convertTools, chatRequest, geminiResponse };
