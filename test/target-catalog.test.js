'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TARGET_CATALOG, catalogTarget } = require('../lib/target-catalog');
const { RECOMMENDED, detectCatalog, doctorTarget } = require('../lib/target-manager');
const { TARGETS, createCrushRouting, createQwenRouting, createKiloConfig } = require('../lib/target-registry');


test('catalog cards expose official websites for download or documentation', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSource, /Official website \/ download/);
  for (const target of TARGET_CATALOG) assert.match(target.homepage, /^https:\/\//);
});

test('requested unsupported targets are not exposed in the active catalog', () => {
  const removedIds = ['cursor-agent', 'cursor-app', 'windsurf-app', 'kiro-cli', 'kiro-app', 'void-app', 'plandex', 'open-interpreter', 'tabby', 'swe-agent', 'openhands', 'jetbrains-ai', 'amp-cli', 'auggie-cli', 'amazon-q-cli', 'roo-vscode', 'kilo-vscode', 'continue-vscode', 'cline-vscode', 'continue-cli', 'goose-cli', 'goose-app', 'vibe-cli'];
  for (const id of removedIds) {
    assert.equal(catalogTarget(id), null, `${id} should not be cataloged`);
    assert.equal(TARGETS.some((target) => target.id === id), false, `${id} should not be launchable`);
  }
});

test('every active catalog target has exactly one registry entry', () => {
  for (const target of TARGET_CATALOG) {
    assert.equal(TARGETS.filter((entry) => entry.id === target.id).length, 1, `${target.id} needs one registry entry`);
  }
});

test('catalog IDs are unique and every entry has compatibility evidence', () => {
  assert.equal(new Set(TARGET_CATALOG.map((target) => target.id)).size, TARGET_CATALOG.length);
  assert.ok(TARGET_CATALOG.length > 0);
  for (const target of TARGET_CATALOG) {
    assert.match(target.id, /^[a-z0-9-]+$/);
    assert.ok(target.name);
    assert.ok(target.mode);
    assert.ok(target.windows);
    assert.match(target.docs, /^https:\/\//);
    assert.ok(['verified', 'implemented', 'experimental', 'cataloged'].includes(target.implementation));
    assert.ok(['verified', 'unverified', 'installed-unverified', 'login-required', 'unsupported-protocol', 'missing-prerequisite', 'provider-error', 'model-unavailable', 'failed'].includes(target.verificationStatus));
  }
});

test('recommended installs are native provider-routed implemented targets', () => {
  assert.deepEqual(RECOMMENDED, ['crush-cli', 'qwen-cli', 'kilo-cli']);
  for (const id of RECOMMENDED) {
    const target = catalogTarget(id);
    assert.equal(target.mode, 'provider-routed');
    assert.equal(target.windows, 'native');
    assert.equal(target.implementation, 'implemented');
    assert.equal(target.verificationStatus, 'verified');
    assert.ok(target.install.length > 0);
    assert.ok(TARGETS.some((entry) => entry.id === id));
  }
});

test('account-bound targets can never be mistaken for routed targets', () => {
  for (const target of TARGET_CATALOG.filter((item) => item.vendorLogin)) {
    assert.notEqual(target.mode, 'provider-routed');
    assert.equal(TARGETS.some((entry) => entry.id === target.id && entry.routing?.includes('compatible')), false);
  }
});

test('catalog detection never returns secrets and does not need version subprocesses', () => {
  const [detected] = detectCatalog([catalogTarget('qwen-cli')]);
  assert.equal(Object.hasOwn(detected, 'apiKey'), false);
  assert.equal(detected.version, null);
  assert.equal(typeof detected.installed, 'boolean');
  assert.equal(detected.verificationStatus, 'verified');
});

test('catalog and UI expose explicit model switching metadata', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pageSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(pageSource, /id="model-picker"/);
  assert.match(pageSource, /id="apply-model"/);
  assert.match(appSource, /modelSwitch/);
  for (const target of TARGETS.filter((item) => item.routing === 'gateway-compatible')) {
    assert.ok(target.modelCommand);
    assert.ok(target.modelSwitch);
  }
});

test('new routed CLI configs contain the full catalog and only a loopback credential', () => {
  const models = ['vendor/model-a', 'vendor/model-b'];
  const qwen = createQwenRouting('http://127.0.0.1:4242/v1', 'nvidia', models[0], models);
  const crush = createCrushRouting('http://127.0.0.1:4242/v1', 'nvidia', models[0], models);
  try {
    const qwenConfig = JSON.parse(fs.readFileSync(path.join(qwen.directory, 'settings.json'), 'utf8'));
    assert.deepEqual(qwenConfig.modelProviders.openai.map((item) => item.id), ['vendor/model-a', 'vendor/model-b']);
    assert.ok(qwenConfig.modelProviders.openai.every((item) => item.envKey === 'CODESWITCHBOARD_LOCAL_KEY'));
    const crushConfig = fs.readFileSync(crush.configPath, 'utf8');
    assert.match(crushConfig, /codeswitchboard-local/);
    assert.match(crushConfig, /nvidia\/vendor\/model-b/);
    const kilo = JSON.parse(createKiloConfig('http://127.0.0.1:4242/v1', 'nvidia', models[0], models));
    assert.deepEqual(Object.keys(kilo.provider.codeswitchboard.models), ['nvidia/vendor/model-a', 'nvidia/vendor/model-b']);
    assert.equal(kilo.provider.codeswitchboard.options.apiKey, '{env:CODESWITCHBOARD_LOCAL_KEY}');
    assert.doesNotMatch(JSON.stringify({ qwenConfig, crushConfig, kilo }), /nvapi-|sk-/);
  } finally {
    fs.rmSync(qwen.directory, { recursive: true, force: true });
    fs.rmSync(crush.directory, { recursive: true, force: true });
  }
});

test('doctor labels native-account requirements honestly', () => {
  const result = doctorTarget('copilot-cli');
  assert.equal(result.mode, 'native-account');
  assert.ok(result.issues.some((issue) => /vendor account/i.test(issue)));
});
