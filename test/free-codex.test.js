'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, restoreStaleConfig } = require('../bin/free-codex');

test('parses keep-app-running as a boolean launch flag', () => {
  const args = parse(['launch', 'codex-app', '--keep-app-running', '--model', 'vendor/model']);
  assert.equal(args['keep-app-running'], true);
  assert.equal(args.model, 'vendor/model');
});

test('parses the internal localhost handoff URL', () => {
  const args = parse(['launch', 'codex-app', '--handoff-url', 'http://127.0.0.1:5000/token']);
  assert.equal(args['handoff-url'], 'http://127.0.0.1:5000/token');
});

test('restores configuration left behind by a dead bridge', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-stale-'));
  const paths = {
    config: path.join(directory, 'config.toml'),
    backup: path.join(directory, 'config.toml.free-codex-backup'),
    lock: path.join(directory, 'free-codex-launch.json')
  };
  try {
    fs.writeFileSync(paths.config, 'model_provider = "dead_bridge"\n');
    fs.writeFileSync(paths.backup, 'model_provider = "openai"\n');
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 2147483647, port: 53295 }));
    restoreStaleConfig(paths);
    assert.equal(fs.readFileSync(paths.config, 'utf8'), 'model_provider = "openai"\n');
    assert.equal(fs.existsSync(paths.backup), false);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
