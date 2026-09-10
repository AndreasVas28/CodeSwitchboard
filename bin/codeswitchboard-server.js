#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { createControlServer } = require('../lib/control-server');

function parseArguments(argv) {
  const result = { port: 4242, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--no-open') result.open = false;
    else if (value === '--help' || value === '-h') result.help = true;
    else if (value === '--port') result.port = Number(argv[++index]);
    else if (value.startsWith('--port=')) result.port = Number(value.slice(7));
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  return result;
}

function usage() {
  console.log(`CodeSwitchboard local launcher

Usage:
  codeswitchboard-server [--port 4242] [--no-open]

The dashboard binds only to 127.0.0.1. Provider keys stay in this process.`);
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process ${JSON.stringify(url)}`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const control = createControlServer();
  const address = await control.listen(args.port);
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`CodeSwitchboard is running at ${url}`);
  console.log('Keys are encrypted for this Windows user. Press Ctrl+C to stop.');
  if (args.open) openBrowser(url);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await control.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(`CodeSwitchboard could not start: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { parseArguments };
