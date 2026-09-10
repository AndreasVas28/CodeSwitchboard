'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, providerById } = require('../lib/provider-registry');
const fs = require('fs');
const path = require('path');
const { TARGETS, createOpenCodeConfig, openCodeModelSelection, createClaudeProxyEnv, createHermesRouting, createHermesProxyEnv, createAiderRouting, createCrushRouting, createQwenRouting, createKiloConfig, claudeDesktopPolicyEntries, resolveTargetExecutable, verifyCli } = require('../lib/target-registry');

test('provider registry includes NVIDIA and a custom endpoint', () => {
  assert.equal(providerById('nvidia').baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(providerById('custom').custom, true);
  assert.equal(PROVIDERS.some((provider) => provider.id === 'openrouter'), true);
});

test('every routed target documents how its model can be switched', () => {
  const routed = TARGETS.filter((target) => ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(target.routing));
  assert.ok(routed.length > 0);
  for (const target of routed) {
    assert.ok(target.modelCommand, `${target.id} needs a model command or picker`);
    assert.ok(target.modelSwitch, `${target.id} needs a visible model-switch description`);
  }
});

test('Hermes uses its classic CLI directly instead of a nested model-wrapper PTY', () => {
  const registrySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  assert.match(registrySource, /target\.id === 'hermes-cli'[\s\S]*?launchTerminal\(executable, \['chat', '--cli'/);
  assert.match(TARGETS.find((target) => target.id === 'hermes-cli').modelSwitch, /classic CLI mode/);
});

test('Hermes routing isolates provider configuration and pins auxiliary title generation', () => {
  const routing = createHermesRouting('http://127.0.0.1:4567/v1', 'vendor/model-a');
  try {
    const config = fs.readFileSync(routing.configPath, 'utf8');
    assert.match(config, /provider: "openai-api"/g);
    assert.match(config, /title_generation:/);
    assert.ok(config.includes('base_url: "http://127.0.0.1:4567/v1"'));
    assert.match(config, /api_key: "codeswitchboard-local"/);
    const env = createHermesProxyEnv({ OPENAI_API_KEY: 'real-secret', NVIDIA_API_KEY: 'other-secret', PATH: 'path' }, 'http://127.0.0.1:4567/v1', routing.directory);
    assert.equal(env.OPENAI_API_KEY, 'codeswitchboard-local');
    assert.equal(env.NVIDIA_API_KEY, undefined);
    assert.equal(env.HERMES_HOME, routing.directory);
    assert.equal(env.PATH, 'path');
  } finally {
    fs.rmSync(routing.directory, { recursive: true, force: true });
  }
});

test('every active catalog target has one registry definition', () => {
  const { TARGET_CATALOG } = require('../lib/target-catalog');
  for (const catalogTarget of TARGET_CATALOG) assert.equal(TARGETS.filter((target) => target.id === catalogTarget.id).length, 1, `${catalogTarget.id} needs one registry definition`);
});

test('Claude Desktop routes through the local Anthropic bridge', () => {
  const target = TARGETS.find((item) => item.id === 'claude-app');
  assert.ok(target, 'claude-app target exists');
  assert.equal(target.kind, 'app');
  assert.equal(target.routing, 'anthropic');
  assert.equal(target.command, undefined, 'must not fall back to the Claude CLI shim');
  assert.ok(target.candidates.some((candidate) => candidate.includes('AnthropicClaude')), 'detects the Windows Claude Desktop install');
});

test('Claude Desktop receives its supported managed gateway configuration', () => {
  const entries = Object.fromEntries(claudeDesktopPolicyEntries('http://127.0.0.1:4567', ['vendor/model-a', 'vendor/model-b']).map(([name, type, value]) => [name, { type, value }]));
  assert.deepEqual(entries.inferenceProvider, { type: 'REG_SZ', value: 'gateway' });
  assert.deepEqual(entries.inferenceCredentialKind, { type: 'REG_SZ', value: 'static' });
  assert.deepEqual(entries.inferenceGatewayBaseUrl, { type: 'REG_SZ', value: 'http://127.0.0.1:4567' });
  assert.deepEqual(entries.inferenceGatewayApiKey, { type: 'REG_SZ', value: 'codeswitchboard-local' });
  assert.deepEqual(entries.inferenceGatewayAuthScheme, { type: 'REG_SZ', value: 'bearer' });
  assert.deepEqual(entries.modelDiscoveryEnabled, { type: 'REG_DWORD', value: '0' });
  assert.deepEqual(JSON.parse(entries.inferenceModels.value), [
    { name: 'claude-codeswitchboard-69ec41cf87c6', labelOverride: 'vendor/model-a' },
    { name: 'claude-codeswitchboard-5489315e6645', labelOverride: 'vendor/model-b' }
  ]);
});

test('Claude Desktop uses a stable bridge port so policy setup is one-time', () => {
  const registrySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  assert.match(registrySource, /CLAUDE_DESKTOP_BRIDGE_PORT = 4243/);
  assert.match(registrySource, /Start-Process powershell\.exe -Verb RunAs/);
  assert.match(registrySource, /Get-AppxPackageManifest/);
  assert.match(registrySource, /shell:AppsFolder/);
  assert.match(registrySource, /restoreClaudeDesktopRouting/);
  assert.doesNotMatch(registrySource, /if \(target\.id === 'claude-app'\)[\s\S]*?spawn\(executable, \[\]/);
});

test('OpenCode configuration references an environment key and selected model', () => {
  const provider = { name: 'Example', baseUrl: 'https://example.test/v1' };
  const config = JSON.parse(createOpenCodeConfig(provider, 'vendor/code-model', 'TEST_PROVIDER_KEY'));
  assert.equal(config.provider.codeswitchboard.options.apiKey, '{env:TEST_PROVIDER_KEY}');
  assert.equal(config.provider.codeswitchboard.options.baseURL, provider.baseUrl);
  assert.equal(config.model, 'codeswitchboard/vendor/code-model');
  const prefixed = JSON.parse(createOpenCodeConfig(provider, 'nvidia/vendor/code-model', 'TEST_PROVIDER_KEY', ['nvidia/vendor/code-model', 'nvidia/vendor/other']));
  assert.equal(prefixed.model, 'codeswitchboard/nvidia/vendor/code-model');
  assert.deepEqual(Object.keys(prefixed.provider.codeswitchboard.models), ['nvidia/vendor/code-model', 'nvidia/vendor/other']);
});

test('Gemini CLI keeps the native terminal instead of the generic model PTY wrapper', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  const start = source.indexOf("if (target.id === 'gemini-cli')");
  const end = source.indexOf("if (target.id === 'crush-cli')", start);
  const branch = source.slice(start, end);
  assert.match(branch, /launchTerminal\(executable/);
  assert.doesNotMatch(branch, /launchModelTerminal\(executable/);
  assert.match(TARGETS.find((target) => target.id === 'gemini-cli').modelSwitch, /relaunch/i);
});

test('Cline keeps the native terminal instead of the generic model PTY wrapper', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  const start = source.indexOf("if (target.id === 'cline-cli')");
  const end = source.indexOf("if (target.id === 'dsh-cli')", start);
  const branch = source.slice(start, end);
  assert.match(branch, /launchTerminal\(executable/);
  assert.doesNotMatch(branch, /launchModelTerminal\(executable/);
  assert.match(TARGETS.find((target) => target.id === 'cline-cli').modelSwitch, /relaunch/i);
});

test('new routed CLIs keep the native terminal instead of the generic model PTY wrapper', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  const end = source.indexOf("if (target.routing === 'native-account')");
  assert.ok(end > 0, 'native-account launch branch exists');
  const segment = source.slice(0, end);
  for (const id of ['crush-cli', 'qwen-cli', 'kilo-cli']) {
    const start = segment.indexOf(`target.id === '${id}'`);
    assert.ok(start >= 0, `${id} launch branch exists`);
    const branch = segment.slice(start, segment.indexOf("\n    }", start) + 6);
    assert.match(branch, /launchTerminal\(executable/);
    assert.doesNotMatch(branch, /launchModelTerminal\(executable/);
    assert.match(TARGETS.find((target) => target.id === id).modelSwitch, /relaunch/i);
  }
});

test('new target routing preserves provider prefixes without double-prefixing model IDs', () => {
  const models = ['vendor/model-a', 'vendor/model-b'];
  const qwen = createQwenRouting('http://127.0.0.1:4242/v1', 'nvidia', 'nvidia/vendor/model-a', ['nvidia/vendor/model-a', ...models]);
  const crush = createCrushRouting('http://127.0.0.1:4242/v1', 'nvidia', 'nvidia/vendor/model-a', ['nvidia/vendor/model-a', ...models]);
  try {
    const qwenConfig = JSON.parse(fs.readFileSync(path.join(qwen.directory, 'settings.json'), 'utf8'));
    assert.deepEqual(qwenConfig.modelProviders.openai.map((item) => item.id), ['vendor/model-a', 'vendor/model-b']);
    assert.equal(qwen.selectedModel, 'vendor/model-a');
    assert.match(fs.readFileSync(crush.configPath, 'utf8'), /nvidia\/vendor\/model-a/);
    assert.doesNotMatch(fs.readFileSync(crush.configPath, 'utf8'), /nvidia\/nvidia\//);
    const kilo = JSON.parse(createKiloConfig('http://127.0.0.1:4242/v1', 'nvidia', 'nvidia/vendor/model-a', ['nvidia/vendor/model-a', ...models]));
    assert.ok(Object.hasOwn(kilo.provider.codeswitchboard.models, 'nvidia/vendor/model-a'));
    assert.equal(kilo.model, 'codeswitchboard/nvidia/vendor/model-a');
  } finally {
    fs.rmSync(qwen.directory, { recursive: true, force: true });
    fs.rmSync(crush.directory, { recursive: true, force: true });
  }
});

test('OpenCode normalizes provider-prefixed selections exactly once', () => {
  assert.deepEqual(openCodeModelSelection('nvidia', 'nvidia/provider/model-a', ['nvidia/provider/model-a', 'nvidia/provider/model-b']), {
    selected: 'provider/model-a',
    selectedProviderModel: 'nvidia/provider/model-a',
    providerModels: ['nvidia/provider/model-a', 'nvidia/provider/model-b']
  });
  assert.deepEqual(openCodeModelSelection('nvidia', 'provider/model-a', ['provider/model-a', 'nvidia/provider/model-b']).providerModels, ['nvidia/provider/model-a', 'nvidia/provider/model-b']);
});

test('OpenCode receives the complete model catalog', () => {
  const provider = { name: 'Example', baseUrl: 'https://example.test/v1' };
  const openCode = JSON.parse(createOpenCodeConfig(provider, 'vendor/model-a', 'TEST_KEY', ['vendor/model-a', 'vendor/model-b']));
  assert.deepEqual(Object.keys(openCode.provider.codeswitchboard.models), ['vendor/model-a', 'vendor/model-b']);
});

test('Aider receives discoverable model settings and metadata', () => {
  const routing = createAiderRouting('vendor/model-a', ['vendor/model-a', 'vendor/model-b']);
  try {
    const settings = JSON.parse(fs.readFileSync(routing.settingsPath, 'utf8'));
    const metadata = JSON.parse(fs.readFileSync(routing.metadataPath, 'utf8'));
    assert.deepEqual(settings.map((item) => item.name), ['openai/vendor/model-a', 'openai/vendor/model-b']);
    assert.deepEqual(Object.keys(metadata), ['openai/vendor/model-a', 'openai/vendor/model-b']);
  } finally {
    fs.rmSync(routing.directory, { recursive: true, force: true });
  }
});

test('Claude configuration replaces account auth with the local provider bridge', () => {
  const env = createClaudeProxyEnv({ ANTHROPIC_API_KEY: 'account-key', PATH: 'test-path' }, 'http://127.0.0.1:4567', 'vendor/code-model');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'codeswitchboard-local');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
  assert.equal(env.ANTHROPIC_MODEL, 'vendor/code-model');
  assert.equal(env.PATH, 'test-path');
});

test('target resolution falls back to a known candidate path', () => {
  const executable = resolveTargetExecutable({
    kind: 'cli',
    command: 'codeswitchboard-command-that-does-not-exist',
    candidates: [__filename]
  });
  assert.equal(executable, __filename);
});

test('CLI preflight accepts a working executable', () => {
  assert.doesNotThrow(() => verifyCli(process.execPath, process.env));
});

test('Codex Desktop dashboard launches restart outside the host app job', () => {
  const registrySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'target-registry.js'), 'utf8');
  const legacySource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'free-codex.js'), 'utf8');
  assert.match(registrySource, /Invoke-CimMethod -ClassName Win32_Process/);
  assert.match(registrySource, /launchOutsideCodexJob/);
  assert.match(legacySource, /args\['handoff-url'\]/);
  assert.match(legacySource, /restartDashboard/);
});
