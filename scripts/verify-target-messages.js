'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TargetLauncher } = require('../lib/target-registry');

const marker = 'CODESWITCHBOARD_OK';

async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

let inferenceRequests = [];
const upstream = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'test/code-model', object: 'model', owned_by: 'test' }] }));
    return;
  }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
    response.writeHead(404).end('Not found');
    return;
  }
  const body = await bodyOf(request);
  inferenceRequests.push({ model: body.model, messages: body.messages, authorization: request.headers.authorization });
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl_test', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
  response.end('data: [DONE]\n\n');
});

async function main() {
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const port = upstream.address().port;
  const launcher = new TargetLauncher({ legacyLauncherPath: path.join(__dirname, '..', 'bin', 'free-codex.js') });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-verify-workspace-'));
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'SAFE_FIXTURE_OK\n');
  const provider = { id: 'test', name: 'Test Provider', baseUrl: `http://127.0.0.1:${port}/v1` };
  const supportedTargets = ['claude-cli', 'opencode-cli', 'aider-cli', 'pi-cli', 'cline-cli', 'dsh-cli', 'hermes-cli', 'gemini-cli', 'crush-cli', 'qwen-cli', 'kilo-cli'];
  const requestedTargets = process.argv.slice(2);
  const targets = requestedTargets.length ? requestedTargets : supportedTargets;
  const unknown = targets.filter((target) => !supportedTargets.includes(target));
  if (unknown.length) throw new Error(`Unknown message-test target(s): ${unknown.join(', ')}`);
  const results = [];
  try {
    for (const targetId of targets) {
      const started = Date.now();
      console.log(`[verify] ${targetId} starting`);
      try {
        const result = await launcher.testMessage({
          targetId, provider, apiKey: 'test-secret', model: 'test/code-model',
          workspace, prompt: `Reply with exactly ${marker}. Do not use tools.`,
          localGatewayBaseUrl: provider.baseUrl
        });
        const passed = result.output.includes(marker) && result.inferenceRequests > 0 && inferenceRequests.length > 0 && inferenceRequests.at(-1).authorization === 'Bearer test-secret';
        results.push({ targetId, passed, seconds: ((Date.now() - started) / 1000).toFixed(1), output: result.output.slice(-300), inferenceRequests: result.inferenceRequests });
        console.log(`[verify] ${targetId} ${results.at(-1).passed ? 'passed' : 'failed'} in ${results.at(-1).seconds}s`);
      } catch (error) {
        results.push({ targetId, passed: false, seconds: ((Date.now() - started) / 1000).toFixed(1), error: error.message });
        console.log(`[verify] ${targetId} failed in ${results.at(-1).seconds}s: ${error.message.slice(-500)}`);
      }
    }
  } finally {
    launcher.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
