'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PersistentStore } = require('../lib/persistent-store');
const { parseLaunch } = require('../bin/csb');

test('persistent store encrypts keys and reloads selections', { skip: process.platform !== 'win32' }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-store-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const store = new PersistentStore(file);
  store.setKey('nvidia', 'test-secret-key');
  store.updateSelections({ providerId: 'nvidia', model: 'vendor/model', targetId: 'claude-app', workspace: 'C:\\work' });

  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /test-secret-key/);
  const reloaded = new PersistentStore(file);
  assert.equal(reloaded.keys().nvidia, 'test-secret-key');
  assert.deepEqual(reloaded.selections(), { providerId: 'nvidia', model: 'vendor/model', targetId: 'claude-app', workspace: 'C:\\work' });
});

test('csb launch parser supports a target and overrides', () => {
  assert.deepEqual(parseLaunch(['claude-app', '--provider', 'nvidia', '--model', 'vendor/model', '--workspace', 'C:\\work']), {
    targetId: 'claude-app', providerId: 'nvidia', model: 'vendor/model', workspace: 'C:\\work'
  });
});
