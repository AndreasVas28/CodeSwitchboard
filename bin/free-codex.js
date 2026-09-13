#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const TOML = require('@iarna/toml');
const { DatabaseSync } = require('node:sqlite');
const { startBridge } = require('../lib/responses-bridge');
const { fetchModelIds, createModelCatalog } = require('../lib/model-catalog');

const PROVIDERS = {
  nvidia: { url: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  groq: { url: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY' },
  together: { url: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY' }
};

// A fixed default keeps ~/.codex/config.toml pointing at a live port across
// restarts; the launcher falls back to an ephemeral port only when 4280 is
// taken (e.g. a previous bridge that outlived its dashboard).
const DEFAULT_BRIDGE_PORT = 4280;

const RETIRED_MODEL_REPLACEMENTS = {
  nvidia: {
    'qwen/qwen3-coder-480b-a35b-instruct': 'poolside/laguna-xs-2.1'
  }
};

function usage(exitCode = 0) {
  console.log(`free-codex - launch the real Codex app with another provider

Usage:
  free-codex launch codex-app --provider nvidia [options]

Options:
  --provider NAME     nvidia, openrouter, groq, together, or custom
  --model ID          Initial model (optional for NVIDIA; selectable in Codex)
  --api-key KEY       API key (prefer the provider environment variable)
  --base-url URL      Required for custom; overrides a preset
  --workspace PATH    Folder to open (default: current folder)
  --port NUMBER       Local bridge port (default: 4280, falls back to an available port)
  --keep-app-running  Reconfigure an already-running Codex app without stopping it
  --handoff-url URL   Internal one-time localhost launch handoff
  --dry-run           Validate and print the launch configuration only
  --restore           Stop bridge, restore settings, and restart Codex in account mode

Example:
  $env:NVIDIA_API_KEY='nvapi-...'
  free-codex launch codex-app --provider nvidia
`);
  process.exit(exitCode);
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith('--')) { out._.push(part); continue; }
    const [rawKey, inline] = part.slice(2).split('=', 2);
    if (rawKey === 'dry-run' || rawKey === 'help' || rawKey === 'restore' || rawKey === 'keep-app-running') { out[rawKey] = true; continue; }
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawKey}`);
    out[rawKey] = value;
  }
  return out;
}

function findCodexLaunch() {
  if (process.platform === 'win32') {
    const ps1 = path.join(process.env.APPDATA || '', 'npm', 'codex.ps1');
    if (fs.existsSync(ps1)) return { command: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1] };
  }
  return { command: 'codex', prefix: [] };
}

function codexConfigPaths() {
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
  return {
    config: path.join(home, 'config.toml'),
    backup: path.join(home, 'config.toml.free-codex-backup'),
    lock: path.join(home, 'free-codex-launch.json')
  };
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function restoreStaleConfig(paths) {
  if (!fs.existsSync(paths.backup)) return;
  let ownerAlive = false;
  try { ownerAlive = processExists(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).pid); } catch {}
  if (ownerAlive) throw new Error('Another free-codex launcher is already running. Stop it with Ctrl+C first.');
  fs.copyFileSync(paths.backup, paths.config);
  fs.rmSync(paths.backup, { force: true });
  fs.rmSync(paths.lock, { force: true });
  console.log('Recovered Codex configuration left by an interrupted launcher.');
}

function defaultWorkspace(requested) {
  if (requested) return path.resolve(requested);
  const currentDirectory = process.cwd();
  const windowsSystemDirectory = process.platform === 'win32' && /^([a-z]:\\windows\\system32)\\?$/i.test(currentDirectory);
  return path.resolve(windowsSystemDirectory ? process.env.USERPROFILE : currentDirectory);
}

function restoreNormalCodex() {
  const paths = codexConfigPaths();
  if (!fs.existsSync(paths.backup)) {
    fs.rmSync(paths.lock, { force: true });
    console.log('Codex is already using its normal account configuration.');
  } else {
    let ownerPid;
    try { ownerPid = Number(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).pid); } catch {}
    fs.copyFileSync(paths.backup, paths.config);
    fs.rmSync(paths.backup, { force: true });
    fs.rmSync(paths.lock, { force: true });
    if (ownerPid && ownerPid !== process.pid && processExists(ownerPid)) {
      try { process.kill(ownerPid, 'SIGTERM'); } catch (error) { console.warn(`Settings were restored, but bridge process ${ownerPid} could not be stopped: ${error.message}`); }
    }
    console.log('Restored normal Codex account settings and stopped the free-codex bridge.');
  }
  if (process.platform === 'win32') {
    stopWindowsCodex();
    const migrated = migrateLatestExternalThreadToOpenAI(paths);
    restartWindowsCodexHome(migrated?.id);
    if (migrated) console.log(`Migrated and reopened the same Codex task: ${migrated.title || migrated.id}`);
    else console.log('Restarted Codex in normal account mode (no external-provider task needed migration).');
    console.log('Codex will use its saved account, or show the official sign-in screen if no account is saved.');
  } else {
    console.log('Restart Codex to use its normal account or official sign-in flow.');
  }
}

function migrateLatestExternalThreadToOpenAI(paths) {
  const home = path.dirname(paths.config);
  const statePath = path.join(home, 'state_5.sqlite');
  if (!fs.existsSync(statePath)) return null;

  let accountModel = 'gpt-5.6-sol';
  try {
    const restoredConfig = TOML.parse(fs.readFileSync(paths.config, 'utf8'));
    if (typeof restoredConfig.model === 'string' && restoredConfig.model) accountModel = restoredConfig.model;
  } catch {}

  const db = new DatabaseSync(statePath);
  let thread;
  try {
    thread = db.prepare(`
      SELECT id, title, model_provider, model, rollout_path
      FROM threads
      WHERE model_provider IN ('free_codex_bridge', 'ollama-launch', 'ollama-launch-codex-app')
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT 1
    `).get();
    if (!thread) return null;

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backupDirectory = path.join(home, 'free-codex-backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(statePath, path.join(backupDirectory, `state_5-before-restore-${stamp}.sqlite`));

    const rawRolloutPath = String(thread.rollout_path || '');
    const rolloutPath = rawRolloutPath.startsWith('\\\\?\\') ? rawRolloutPath.slice(4) : rawRolloutPath;
    if (rolloutPath && fs.existsSync(rolloutPath)) {
      const rolloutBackup = path.join(backupDirectory, `${path.basename(rolloutPath)}.${stamp}.bak`);
      fs.copyFileSync(rolloutPath, rolloutBackup);
      const records = fs.readFileSync(rolloutPath, 'utf8').split(/(?<=\n)/);
      const updated = records.map((line) => {
        if (!line.trim()) return line;
        try {
          const record = JSON.parse(line);
          if (record.type === 'session_meta' && record.payload?.id === thread.id) {
            record.payload.model_provider = 'openai';
            return `${JSON.stringify(record)}\n`;
          }
        } catch {}
        return line;
      }).join('');
      fs.writeFileSync(rolloutPath, updated);
    }

    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE threads SET model_provider = ?, model = ? WHERE id = ?')
      .run('openai', accountModel, thread.id);
    db.exec('COMMIT');
    return thread;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Could not migrate the existing Codex task to account mode: ${error.message}`);
  } finally {
    db.close();
  }
}

function installConfigOverlay({ model, localBaseUrl, providerName, modelCatalogPath, ownerPid, bridgePort }) {
  const paths = codexConfigPaths();
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  restoreStaleConfig(paths);
  const original = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '';
  let config;
  try { config = original.trim() ? TOML.parse(original) : {}; } catch (error) { throw new Error(`Cannot safely parse ${paths.config}: ${error.message}`); }
  fs.writeFileSync(paths.backup, original, { flag: 'wx' });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: ownerPid || process.pid, port: bridgePort, providerName, startedAt: new Date().toISOString() }));
  config.model = model;
  config.model_provider = 'free_codex_bridge';
  if (modelCatalogPath) config.model_catalog_json = modelCatalogPath;
  config.model_providers ||= {};
  config.model_providers.free_codex_bridge = {
    name: `${providerName} via CodeSwitchboard`,
    base_url: localBaseUrl,
    wire_api: 'responses',
    requires_openai_auth: false
  };
  fs.writeFileSync(paths.config, TOML.stringify(config));
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (fs.existsSync(paths.backup)) fs.copyFileSync(paths.backup, paths.config);
      fs.rmSync(paths.backup, { force: true });
      fs.rmSync(paths.lock, { force: true });
      console.log('Restored your original Codex configuration.');
    } catch (error) { console.error(`Could not restore Codex configuration: ${error.message}`); }
  };
}

function bridgeLogPath() {
  return path.join(path.dirname(codexConfigPaths().config), 'free-codex-bridge.log');
}

async function bridgeDaemonMain() {
  const args = parse(process.argv.slice(3));
  const stateFile = args['state-file'];
  const apiKey = process.env.FREE_CODEX_DAEMON_API_KEY;
  if (!stateFile || !args['base-url'] || !apiKey) throw new Error('Incomplete bridge daemon configuration.');
  const models = (args.models || '').split(',').map((id) => id.trim()).filter(Boolean);
  const bridge = await startBridge({
    port: args.port ? Number(args.port) : 0,
    upstreamBaseUrl: args['base-url'],
    apiKey,
    providerName: args.provider || 'custom',
    model: args.model,
    models
  });
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: bridge.port,
    providerName: args.provider || 'custom',
    model: args.model,
    startedAt: new Date().toISOString()
  }));
  const stop = () => bridge.close(() => {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.pid === process.pid) fs.rmSync(stateFile, { force: true });
    } catch {}
    process.exit();
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function startBridgeDaemon({ port, upstreamBaseUrl, apiKey, providerName, model, models = [] }) {
  const paths = codexConfigPaths();
  if (fs.existsSync(paths.lock)) {
    let existingPid;
    try { existingPid = Number(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).pid); } catch {}
    if (existingPid && processExists(existingPid)) throw new Error('A free-codex bridge is already running. Use --restore before launching another one.');
    fs.rmSync(paths.lock, { force: true });
  }
  const logPath = bridgeLogPath();
  const logHandle = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [
    __filename,
    'bridge-daemon',
    '--provider', providerName,
    '--base-url', upstreamBaseUrl,
    '--port', String(port || 0),
    '--state-file', paths.lock,
    ...(model ? ['--model', model] : []),
    ...(models.length ? ['--models', models.join(',')] : [])
  ], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logHandle, logHandle],
    env: { ...process.env, FREE_CODEX_DAEMON_API_KEY: apiKey }
  });
  fs.closeSync(logHandle);
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
      if (state.pid === child.pid && state.port) {
        const health = await fetch(`http://127.0.0.1:${state.port}/health`);
        if (health.ok) return state;
      }
    } catch {}
    if (!processExists(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  throw new Error(`The background bridge did not start. Check ${logPath}.`);
}

function windowsCodexInstalled() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "if (Get-AppxPackage -Name OpenAI.Codex) { exit 0 } else { exit 1 }"], { windowsHide: true });
  return result.status === 0;
}

function launchWindowsCodex(workspace, threadId) {
  if (!windowsCodexInstalled()) throw new Error('The OpenAI.Codex Microsoft Store package is not installed for this Windows user.');
  const uri = threadId
    ? `codex://threads/${threadId}`
    : `codex://threads/new?cwd=${encodeURIComponent(workspace)}`;
  const activation = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process ${JSON.stringify(uri)}`], { windowsHide: true, timeout: 10000 });
  if (activation.status !== 0) throw new Error(`Windows could not activate Codex: ${activation.stderr?.toString().trim() || 'unknown activation error'}`);

  // Store apps may activate behind the terminal when an existing process owns the window.
  const focusScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FreeCodexWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
for ($i = 0; $i -lt 30; $i++) {
  $window = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($window) {
    [FreeCodexWindow]::ShowWindowAsync($window.MainWindowHandle, 9) | Out-Null
    [FreeCodexWindow]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
    exit 0
  }
  Start-Sleep -Milliseconds 200
}
exit 1`;
  const focused = spawnSync('powershell.exe', ['-NoProfile', '-Command', focusScript], { windowsHide: true, timeout: 10000 });
  if (focused.status !== 0) console.warn('Codex started, but Windows did not expose its main window. Use Alt+Tab to select Codex.');
}

function migrateLatestWorkspaceThreadToExternalProvider(paths, workspace, model) {
  const statePath = path.join(path.dirname(paths.config), 'state_5.sqlite');
  if (!fs.existsSync(statePath)) return null;
  const db = new DatabaseSync(statePath);
  try {
    const normalizedWorkspace = path.resolve(workspace).replace(/[\\/]+$/, '').toLowerCase();
    const candidates = db.prepare(`
      SELECT id, title, rollout_path, cwd
      FROM threads
      WHERE archived = 0
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
    `).all();
    const thread = candidates.find((item) => path.resolve(item.cwd).replace(/[\\/]+$/, '').toLowerCase() === normalizedWorkspace)
      || candidates[0];
    if (!thread) return null;

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backupDirectory = path.join(path.dirname(paths.config), 'free-codex-backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(statePath, path.join(backupDirectory, `state_5-before-nvidia-${stamp}.sqlite`));

    const rawRolloutPath = String(thread.rollout_path || '');
    const rolloutPath = rawRolloutPath.startsWith('\\\\?\\') ? rawRolloutPath.slice(4) : rawRolloutPath;
    if (rolloutPath && fs.existsSync(rolloutPath)) {
      fs.copyFileSync(rolloutPath, path.join(backupDirectory, `${path.basename(rolloutPath)}.${stamp}.bak`));
      const records = fs.readFileSync(rolloutPath, 'utf8').split(/(?<=\n)/);
      const updated = records.map((line) => {
        if (!line.trim()) return line;
        try {
          const record = JSON.parse(line);
          if (record.type === 'session_meta' && record.payload?.id === thread.id) {
            record.payload.model_provider = 'free_codex_bridge';
            return `${JSON.stringify(record)}\n`;
          }
        } catch {}
        return line;
      }).join('');
      fs.writeFileSync(rolloutPath, updated);
    }

    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE threads SET model_provider = ?, model = ? WHERE id = ?')
      .run('free_codex_bridge', model, thread.id);
    db.exec('COMMIT');
    return thread;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw new Error(`Could not attach the existing Codex task to NVIDIA: ${error.message}`);
  } finally {
    db.close();
  }
}

function stopWindowsCodex() {
  if (!windowsCodexInstalled()) throw new Error('The OpenAI.Codex Microsoft Store package is not installed for this Windows user.');
  const script = `
$package = Get-AppxPackage -Name OpenAI.Codex
if (-not $package) { exit 2 }
$installRoot = $package.InstallLocation
Get-Process ChatGPT -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force
Start-Sleep -Milliseconds 500
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`Could not stop Codex before restoring its task: ${result.stderr?.toString().trim() || `exit code ${result.status}`}`);
}

function restartWindowsCodexHome(threadId) {
  if (!windowsCodexInstalled()) throw new Error('The OpenAI.Codex Microsoft Store package is not installed for this Windows user.');
  const target = threadId ? `codex://threads/${threadId}` : null;
  const script = target ? `
Start-Process ${JSON.stringify(target)}
` : `
$package = Get-AppxPackage -Name OpenAI.Codex
$appId = $package.PackageFamilyName + '!App'
Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\' + $appId)
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`Could not restart Codex: ${result.stderr?.toString().trim() || `exit code ${result.status}`}`);
}

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); } catch (error) { console.error(error.message); usage(2); }
  if (args.help || args._[0] === 'help' || !args._.length) usage();
  if (args._[0] !== 'launch' || !['codex-app', 'CODEX-APP'].includes(args._[1])) {
    console.error('Expected: free-codex launch codex-app'); usage(2);
  }
  if (args.restore) { restoreNormalCodex(); return; }
  if (args['handoff-url']) {
    const handoffUrl = new URL(args['handoff-url']);
    if (handoffUrl.protocol !== 'http:' || handoffUrl.hostname !== '127.0.0.1') throw new Error('The launch handoff must use localhost.');
    const response = await fetch(handoffUrl);
    if (!response.ok) throw new Error(`Could not receive the launch handoff (${response.status}).`);
    const handoff = await response.json();
    args = {
      ...args,
      provider: handoff.provider,
      model: handoff.model,
      models: Array.isArray(handoff.models) ? handoff.models.join(',') : undefined,
      workspace: handoff.workspace,
      'base-url': handoff.baseUrl,
      'api-key': handoff.apiKey,
      'restart-dashboard': Boolean(handoff.restartDashboard)
    };
  }
  const providerName = (args.provider || 'nvidia').toLowerCase();
  const preset = PROVIDERS[providerName];
  if (!preset && providerName !== 'custom') throw new Error(`Unknown provider: ${providerName}`);
  if (!args.model && providerName !== 'nvidia') throw new Error('--model is required for this provider');
  const requestedModel = args.model || 'poolside/laguna-xs-2.1';
  let model = RETIRED_MODEL_REPLACEMENTS[providerName]?.[requestedModel] || requestedModel;
  if (model !== requestedModel) console.warn(`NVIDIA retired ${requestedModel}; using ${model} instead.`);
  const baseUrl = (args['base-url'] || preset?.url || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('--base-url is required for a custom provider');
  const envName = preset?.env || 'CODEX_PROVIDER_API_KEY';
  const apiKey = args['api-key'] || process.env[envName];
  if (!apiKey) throw new Error(`No API key. Pass --api-key or set ${envName}.`);
  const workspace = defaultWorkspace(args.workspace);
  if (!fs.existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const config = { providerName, baseUrl, model, workspace };
  if (args['dry-run']) { console.log(JSON.stringify(config, null, 2)); return; }

  let modelCatalogPath;
  let bridgeModels = [model];
  if (providerName === 'nvidia') {
    const modelIds = await fetchModelIds({ baseUrl, apiKey });
    if (!modelIds.includes(model)) {
      model = modelIds.includes('poolside/laguna-xs-2.1') ? 'poolside/laguna-xs-2.1' : modelIds[0];
      console.warn(`Requested model is unavailable; using ${model}.`);
    }
    bridgeModels = modelIds;
    modelCatalogPath = path.join(path.dirname(codexConfigPaths().config), 'free-codex-nvidia-models.json');
    fs.writeFileSync(modelCatalogPath, `${JSON.stringify(createModelCatalog(modelIds, model), null, 2)}\n`);
    console.log(`Loaded ${modelIds.length} NVIDIA models for the Codex model menu.`);
  } else {
    try {
      const modelIds = await fetchModelIds({ baseUrl, apiKey });
      bridgeModels = modelIds.includes(model) ? modelIds : [model, ...modelIds];
    } catch (error) {
      console.warn(`Could not load the provider model list for the bridge (${error.message}); continuing with the selected model only.`);
    }
  }

  if (process.platform === 'win32') {
    // Repair an overlay left behind when the previous bridge process died before
    // starting the replacement daemon. Doing this after daemon startup would make
    // restoreStaleConfig mistake the new daemon for the owner of the stale overlay.
    restoreStaleConfig(codexConfigPaths());
    const daemon = await startBridgeDaemon({ port: args.port ? Number(args.port) : DEFAULT_BRIDGE_PORT, upstreamBaseUrl: baseUrl, apiKey, providerName, model, models: bridgeModels });
    const localBaseUrl = `http://127.0.0.1:${daemon.port}/v1`;
    console.log(`Bridge: ${localBaseUrl} -> ${baseUrl}`);
    console.log(`Launching real Codex app with model: ${model}`);
    const restoreConfig = installConfigOverlay({ model, localBaseUrl, providerName, modelCatalogPath, ownerPid: daemon.pid, bridgePort: daemon.port });
    try {
      // CodeSwitchboard can itself be running underneath Codex Desktop. Killing
      // the app in that situation also kills the dashboard and bridge descendants,
      // leaving Codex configured to a dead localhost port. Dashboard launches use
      // --keep-app-running and reactivate the task after installing the overlay.
      if (!args['keep-app-running']) stopWindowsCodex();
      const existingThread = migrateLatestWorkspaceThreadToExternalProvider(codexConfigPaths(), workspace, model);
      launchWindowsCodex(workspace, existingThread?.id);
      if (args['restart-dashboard']) restartDashboard({ envName, apiKey });
      if (existingThread) console.log(`Reopened the same task through ${providerName}: ${existingThread.title || existingThread.id}`);
      console.log('The bridge is running in the background. Use free-codex launch codex-app --restore to stop it.');
    } catch (error) {
      restoreConfig();
      try { process.kill(daemon.pid, 'SIGTERM'); } catch {}
      throw error;
    }
  } else {
    const bridge = await startBridge({ port: args.port ? Number(args.port) : DEFAULT_BRIDGE_PORT, upstreamBaseUrl: baseUrl, apiKey, providerName, model, models: bridgeModels });
    const localBaseUrl = `http://127.0.0.1:${bridge.port}/v1`;
    console.log(`Bridge: ${localBaseUrl} -> ${baseUrl}`);
    console.log(`Launching Codex with model: ${model}`);
    console.log('Keep this terminal open. Press Ctrl+C to stop the bridge.');
    const launch = findCodexLaunch();
    const providerId = 'free_codex_bridge';
    const catalogArgs = modelCatalogPath ? ['-c', `model_catalog_json=${JSON.stringify(modelCatalogPath)}`] : [];
    const codexArgs = [...launch.prefix, 'app', workspace, '-c', `model=${JSON.stringify(model)}`, '-c', `model_provider=${JSON.stringify(providerId)}`, '-c', `model_providers.${providerId}.name=${JSON.stringify(`${providerName} via CodeSwitchboard`)}`, '-c', `model_providers.${providerId}.base_url=${JSON.stringify(localBaseUrl)}`, '-c', `model_providers.${providerId}.wire_api="responses"`, '-c', `model_providers.${providerId}.requires_openai_auth=false`, ...catalogArgs];
    const child = spawn(launch.command, codexArgs, { stdio: 'inherit', windowsHide: true });
    child.on('error', (error) => { console.error(`Could not run Codex: ${error.message}`); bridge.close(); process.exitCode = 1; });
    const stop = () => bridge.close(() => process.exit());
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
}

function restartDashboard({ envName, apiKey }) {
  const serverPath = path.join(__dirname, 'codeswitchboard-server.js');
  const logDirectory = path.join(__dirname, '..', 'dist');
  fs.mkdirSync(logDirectory, { recursive: true });
  const stdout = fs.openSync(path.join(logDirectory, 'server.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(logDirectory, 'server.stderr.log'), 'a');
  const child = spawn(process.execPath, [serverPath, '--no-open'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
    env: { ...process.env, [envName]: apiKey }
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.unref();
}

if (require.main === module) {
  if (process.argv[2] === 'bridge-daemon') {
    bridgeDaemonMain().catch((error) => { console.error(`free-codex bridge: ${error.message}`); process.exitCode = 1; });
  } else {
    main().catch((error) => { console.error(`free-codex: ${error.message}`); process.exitCode = 1; });
  }
}

module.exports = { parse, restoreStaleConfig };
