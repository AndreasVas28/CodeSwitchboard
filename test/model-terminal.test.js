'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

function waitFor(getOutput, marker, timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (getOutput().includes(marker)) resolve();
      else if (Date.now() - started > timeout) reject(new Error(`Timed out waiting for ${marker}: ${getOutput().slice(-2000)}`));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

test('model terminal turns /models into a searchable selector and native switch command', async () => {
  const wrapper = path.join(__dirname, '..', 'bin', 'codeswitchboard-model-terminal.js');
  const fixture = path.join(__dirname, 'fixtures', 'model-terminal-child.js');
  let output = '';
  const terminal = spawn(process.execPath, [wrapper], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CODESWITCHBOARD_CHILD_EXECUTABLE: process.execPath,
      CODESWITCHBOARD_CHILD_ARGS: JSON.stringify([fixture]),
      CODESWITCHBOARD_MODELS: JSON.stringify(['vendor/model-a', 'vendor/model-b']),
      CODESWITCHBOARD_MODEL_COMMAND: '/model {model}',
      CODESWITCHBOARD_TEST_PIPE_CHILD: '1'
    }
  });
  terminal.stdout.on('data', (data) => { output += data.toString(); });
  terminal.stderr.on('data', (data) => { output += data.toString(); });
  try {
    await waitFor(() => output, 'CHILD_READY');
    // Windows Terminal/ConPTY can answer a child capability query on stdin.
    // The wrapper must consume that CSI response instead of forwarding it as
    // visible prompt text.
    terminal.stdin.write('\x1b[40;80;0;1;288;1_');
    terminal.stdin.write('\x1b[<0;71;22M\x1b[<0;71;22m');
    terminal.stdin.write('[72;35;104;1;32;1_');
    terminal.stdin.write('[73;23;105;1;32;1_');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(output, /40;80;0;1;288;1_|72;35;104;1;32;1_|73;23;105;1;32;1_/);
    assert.doesNotMatch(output, /<0;71;22[Mm]/);
    terminal.stdin.write('/models\r');
    await waitFor(() => output, 'CodeSwitchboard models');
    terminal.stdin.write('model-b\r');
    await waitFor(() => output, 'SWITCHED:vendor/model-b');
    assert.match(output, /2\/2 models/);
  } finally {
    terminal.kill();
  }
});
