#!/usr/bin/env node
'use strict';

const pty = require('node-pty');
const { spawn } = require('child_process');

function parseJson(name, fallback) {
  try { return JSON.parse(process.env[name] || ''); } catch { return fallback; }
}

const executable = process.env.CODESWITCHBOARD_CHILD_EXECUTABLE;
const args = parseJson('CODESWITCHBOARD_CHILD_ARGS', []);
const models = [...new Set(parseJson('CODESWITCHBOARD_MODELS', []).filter((item) => typeof item === 'string' && item.trim()))];
const commandTemplate = process.env.CODESWITCHBOARD_MODEL_COMMAND || '/model {model}';
const displayPrefix = process.env.CODESWITCHBOARD_MODEL_DISPLAY_PREFIX || '';

if (!executable) {
  process.stderr.write('CodeSwitchboard terminal configuration is incomplete.\n');
  process.exit(1);
}

function spawnChild() {
  if (process.env.CODESWITCHBOARD_TEST_PIPE_CHILD === '1') {
    const processChild = spawn(executable, args, { cwd: process.cwd(), env: process.env, windowsHide: true });
    return {
      write: (data) => processChild.stdin.write(data),
      resize: () => {},
      onData: (handler) => {
        processChild.stdout.on('data', (data) => handler(data.toString()));
        processChild.stderr.on('data', (data) => handler(data.toString()));
      },
      onExit: (handler) => processChild.on('exit', (exitCode) => handler({ exitCode: exitCode || 0 }))
    };
  }
  return pty.spawn(executable, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env
  });
}

const child = spawnChild();

let line = '';
let selecting = false;
let query = '';
let selectedIndex = 0;
let queuedOutput = '';
let pendingInputEscape = '';
let pendingOutputEscape = '';

function filteredModels() {
  const needle = query.toLowerCase();
  return needle ? models.filter((model) => model.toLowerCase().includes(needle)) : models;
}

function renderSelector() {
  const filtered = filteredModels();
  if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);
  const height = Math.max(5, Math.min(18, (process.stdout.rows || 30) - 7));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(height / 2), filtered.length - height));
  const visible = filtered.slice(start, start + height);
  let output = '\x1b[2J\x1b[H';
  output += '\x1b[1;36mCodeSwitchboard models\x1b[0m\n';
  output += `Search: ${query || '\x1b[2mtype to filter\x1b[0m'}\n\n`;
  if (!visible.length) output += '  No matching models\n';
  for (let index = 0; index < visible.length; index += 1) {
    const absolute = start + index;
    const label = `${displayPrefix}${visible[index]}`;
    output += absolute === selectedIndex ? `\x1b[7m> ${label}\x1b[0m\n` : `  ${label}\n`;
  }
  output += `\n\x1b[2m${filtered.length}/${models.length} models · type /model or /models · ↑↓ select · Enter switch · Esc cancel\x1b[0m`;
  process.stdout.write(output);
}

function beginSelector() {
  if (!models.length) {
    process.stdout.write('\r\n\x1b[33mCodeSwitchboard: no provider models are loaded. Reconnect the provider and relaunch.\x1b[0m\r\n');
    return;
  }
  selecting = true;
  query = '';
  selectedIndex = 0;
  queuedOutput = '';
  process.stdout.write('\x1b[?1049h');
  renderSelector();
}

function closeSelector(model) {
  selecting = false;
  process.stdout.write('\x1b[?1049l');
  if (queuedOutput) process.stdout.write(queuedOutput);
  queuedOutput = '';
  if (!model) return;
  const command = commandTemplate.replace('{model}', model);
  child.write(`${command}\r`);
}

function handleSelectorInput(data) {
  for (let index = 0; index < data.length; index += 1) {
    const remaining = data.slice(index);
    if (remaining.startsWith('\x1b[A')) { selectedIndex = Math.max(0, selectedIndex - 1); index += 2; continue; }
    if (remaining.startsWith('\x1b[B')) { selectedIndex = Math.min(Math.max(0, filteredModels().length - 1), selectedIndex + 1); index += 2; continue; }
    const character = data[index];
    if (character === '\x1b' || character === '\x03') { closeSelector(); return; }
    if (character === '\r' || character === '\n') { closeSelector(filteredModels()[selectedIndex]); return; }
    if (character === '\x7f' || character === '\b') { query = query.slice(0, -1); selectedIndex = 0; }
    else if (/^[\x20-\x7e]$/.test(character)) { query += character; selectedIndex = 0; }
  }
  renderSelector();
}

function filterTerminalQueryResponses(data, channel = 'input') {
  // Windows Terminal capability replies use a very specific CSI form ending
  // in underscore, such as ESC[72;35;104;1;32;1_. Some PTY paths strip ESC.
  // Match only that form; never interpret an ordinary '[' typed by a user or
  // an ANSI cursor/key sequence as a terminal query. Keep separate buffers so
  // a response split across chunks is still removed without delaying input.
  let pending = channel === 'output' ? pendingOutputEscape : pendingInputEscape;
  pending += data;
  // Windows also injects ConPTY mouse-event reports on stdin in SGR form,
  // such as ESC[<0;71;22M (and the matching m release event). These are not
  // user keystrokes; forwarding them makes CLIs print raw garbage in the
  // prompt. Strip them in both directions along with capability replies.
  const response = /(?:\x1b)?\[[0-9;?:> ]+_|(?:\x1b)?\[<[0-9;]+[Mm]/g;
  let output = '';
  let cursor = 0;
  let match;
  while ((match = response.exec(pending))) {
    output += pending.slice(cursor, match.index);
    cursor = response.lastIndex;
  }
  const remainder = pending.slice(cursor);
  // Only hold a possible partial response. A bare '[' is not buffered unless
  // it already contains a separator; this keeps normal Cline text responsive.
  const partial = remainder.match(/(?:\x1b)?\[[0-9;?:> ]*$/u);
  if (partial && (partial[0].includes('\x1b') || partial[0].includes(';'))) {
    output += remainder.slice(0, partial.index);
    pending = partial[0];
  } else {
    output += remainder;
    pending = '';
  }
  if (channel === 'output') pendingOutputEscape = pending;
  else pendingInputEscape = pending;
  return output;
}

function handleInput(data) {
  data = filterTerminalQueryResponses(data, 'input');
  if (!data) return;
  if (selecting) { handleSelectorInput(data); return; }
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      if (['/model', '/models'].includes(line.trim())) {
        child.write('\x7f'.repeat(line.length));
        line = '';
        beginSelector();
        continue;
      }
      line = '';
      child.write(character);
    } else if (character === '\x7f' || character === '\b') {
      line = line.slice(0, -1);
      child.write(character);
    } else {
      if (character === '\x15') line = '';
      else if (character >= ' ' && character !== '\x7f') line += character;
      child.write(character);
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => handleInput(chunk.toString('utf8')));
child.onData((data) => {
  const clean = filterTerminalQueryResponses(data, 'output');
  if (selecting) queuedOutput += clean;
  else process.stdout.write(clean);
});
child.onExit(({ exitCode }) => {
  if (selecting) process.stdout.write('\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(exitCode);
});
process.stdout.on('resize', () => child.resize(process.stdout.columns || 120, process.stdout.rows || 30));
process.on('SIGINT', () => { if (selecting) closeSelector(); else child.write('\x03'); });
