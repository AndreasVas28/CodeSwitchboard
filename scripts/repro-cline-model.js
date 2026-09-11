'use strict';

// Reproduction harness: drives `cline --tui`, types /model, and logs every
// request the CLI makes to a mock OpenAI-compatible bridge, so the crash can be
// attributed to a specific request or rendered value.

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const requests = [];
const bridge = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, body: body.slice(0, 400) });
    console.log(`[mock] ${req.method} ${req.url}${body ? ` body=${body.slice(0, 200)}` : ''}`);
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock/model-a', object: 'model', owned_by: 'mock' }, { id: 'mock/model-b', object: 'model', owned_by: 'mock' }] }));
      return;
    }
    if (req.method === 'POST' && req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: Date.now(), model: 'mock/model-a', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    if (req.method === 'POST' && req.url.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_mock', object: 'response', status: 'completed', model: 'mock/model-a', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
      return;
    }
    console.log(`[mock] 404 for ${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

function findCline() {
  const lookup = require('child_process').spawnSync('where.exe', ['cline'], { encoding: 'utf8' });
  const matches = String(lookup.stdout || '').split(/\r?\n/).filter(Boolean);
  return matches.find((line) => /\.cmd$/i.test(line.trim())) || matches.find((line) => /\.exe$/i.test(line.trim())) || null;
}

function unwrapNpmCommand(executable) {
  const shim = fs.readFileSync(executable, 'utf8');
  const match = shim.match(/"%dp0%\\([^"]+)"\s+%\*\s*$/im);
  if (!match) return { executable, args: [] };
  const target = path.resolve(path.dirname(executable), match[1]);
  return { executable: target, args: [] };
}

async function main() {
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${bridge.address().port}/v1`;
  console.log(`[harness] mock bridge at ${baseUrl}`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-model-repro-'));
  const settings = path.join(directory, 'data', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  const provider = { provider: 'openai-native', apiKey: 'repro-local', model: 'mock/model-a', baseUrl };
  fs.writeFileSync(path.join(settings, 'providers.json'), JSON.stringify({
    version: 1, lastUsedProvider: 'openai-native', modes: {},
    providers: { 'openai-native': { settings: provider, updatedAt: new Date().toISOString(), tokenSource: 'manual' } }
  }, null, 2));
  console.log(`[harness] config at ${directory}`);

  const where = findCline();
  if (!where) throw new Error('cline not found on PATH');
  const unwrapped = where.toLowerCase().endsWith('.cmd') ? unwrapNpmCommand(where) : { executable: where, args: [] };
  console.log(`[harness] spawning ${unwrapped.executable}`);

  const pty = require('node-pty');
  const term = pty.spawn(process.execPath, [unwrapped.executable, '--config', directory, '--data-dir', path.join(directory, 'data'), '--provider', 'openai-native', '--model', 'mock/model-a', '--tui'], {
    cwd: directory, env: process.env, cols: 110, rows: 32, name: 'xterm-256color'
  });

  let output = '';
  term.onData((data) => { output += data; });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const strip = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/[\r\n]+/g, ' ').replace(/\s{3,}/g, ' ');
  await sleep(9000); // let the TUI boot fully
  console.log(`[harness] after boot: ${strip(output).slice(-400)}`);
  term.write('/');
  await sleep(1200);
  console.log(`[harness] after slash: ${strip(output).slice(-500)}`);
  term.write('model');
  await sleep(1200);
  console.log(`[harness] after typing: ${strip(output).slice(-500)}`);
  term.write('\r');
  await sleep(8000); // let the dialog load/render/crash

  const crashed = /Text must be created inside of a text node|Error:/.test(output);
  console.log(`[harness] crashed=${crashed}`);
  const tail = output.slice(-3000).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
  console.log('[harness] ---- last TUI output ----');
  console.log(tail);
  console.log('[harness] ---- requests seen ----');
  for (const request of requests) console.log(`  ${request.method} ${request.url}`);

  term.kill();
  await sleep(1000);
  bridge.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = crashed ? 1 : 0;
}

main().catch((error) => { console.error('[harness] failed:', error); bridge.close(); process.exit(2); });
