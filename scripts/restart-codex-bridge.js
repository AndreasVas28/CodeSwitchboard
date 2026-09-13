#!/usr/bin/env node
'use strict';

// Restarts the background Codex bridge daemon onto the current code without
// touching the CodeSwitchboard dashboard (whose process hosts other targets'
// bridges) and without opening Codex again. Typical use: after a machine
// restart, the daemon is gone and ~/.codex/config.toml still points at the
// old (dead) port; run this once and Codex's next message works again.
//
//   node scripts/restart-codex-bridge.js              # reuse the recorded port
//   node scripts/restart-codex-bridge.js --port 0     # pick a fresh port and repoint config.toml

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
const stateFile = path.join(codexHome, 'free-codex-launch.json');
const logFile = path.join(codexHome, 'free-codex-bridge.log');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Reads the routed default from the Codex overlay config (top-level `model = "..."`).
function defaultRoutedModel(home) {
  try {
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const match = config.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch { return null; }
}

function decryptKey(providerId) {
  const store = readJson(path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'CodeSwitchboard', 'config.json'));
  const sealed = store && store.encryptedKeys && store.encryptedKeys[providerId];
  if (!sealed) throw new Error(`No stored ${providerId} key found in the CodeSwitchboard store; start the dashboard once or pass --api-key.`);
  const script = "Add-Type -AssemblyName System.Security;$sealed=[Convert]::FromBase64String([Console]::In.ReadToEnd());$bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: String(sealed), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0 || !result.stdout) throw new Error(`Windows could not decrypt the stored ${providerId} key: ${(result.stderr || `exit ${result.status}`).trim()}`);
  return String(result.stdout);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--api-key') args.apiKey = argv[++index];
    else if (token === '--port') args.port = argv[++index];
    else if (token === '--restore') args.restore = true;
    else if (token === '--provider') args.provider = argv[++index];
    else if (token === '--base-url') args.baseUrl = argv[++index];
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/restart-codex-bridge.js [--port NUMBER|0] [--provider nvidia] [--base-url URL] [--api-key KEY] [--restore]');
    process.exit(0);
  }

  const state = readJson(stateFile);
  if (args.restore) {
    // Same semantics as free-codex restore: put the original config back.
    const backup = path.join(codexHome, 'config.toml.free-codex-backup');
    if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(codexHome, 'config.toml'));
    fs.rmSync(backup, { force: true });
    fs.rmSync(stateFile, { force: true });
    console.log('Restored the original Codex configuration.');
    return;
  }

  const provider = (args.provider || (state && state.providerName) || 'nvidia').toLowerCase();
  const providerPresets = { nvidia: 'https://integrate.api.nvidia.com/v1', openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', together: 'https://api.together.xyz/v1' };
  const baseUrl = (args.baseUrl || providerPresets[provider] || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error(`No base URL known for provider '${provider}'; pass --base-url.`);
  const apiKey = args.apiKey || decryptKey(provider);
  const launcher = path.join(__dirname, '..', 'bin', 'free-codex.js');
  const launcherSource = fs.readFileSync(launcher, 'utf8');
  const portMatch = launcherSource.match(/DEFAULT_BRIDGE_PORT = (\d+)/);
  const defaultPort = portMatch ? Number(portMatch[1]) : 4280;
  const port = args.port !== undefined ? Number(args.port) : (state && state.port) || defaultPort;

  let models = [];
  if (fs.existsSync(path.join(codexHome, 'free-codex-nvidia-models.json'))) {
    const catalog = readJson(path.join(codexHome, 'free-codex-nvidia-models.json'));
    models = Array.isArray(catalog && catalog.models) ? catalog.models.map((entry) => entry.slug).filter(Boolean) : [];
  }
  if (provider !== 'nvidia' || !models.length) {
    const { fetchModelIds } = require('../lib/model-catalog');
    models = await fetchModelIds({ baseUrl, apiKey });
  }
  // The routed default model is what unknown model names (e.g. Codex picking an
  // OpenAI-native model while routed through this bridge) fall back to. Prefer
  // what the previous daemon recorded, then the overlay config, then the default.
  const model = (state && state.model) || defaultRoutedModel(codexHome);

  // Stop the previous daemon if it is somehow still alive, so the port frees up.
  if (state && state.pid && processAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 5000;
    while (processAlive(state.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const logHandle = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [
    launcher,
    'bridge-daemon',
    '--provider', provider,
    '--base-url', baseUrl,
    '--port', String(port),
    '--state-file', stateFile,
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
    const fresh = readJson(stateFile);
    if (fresh && fresh.pid === child.pid && fresh.port) {
      const health = await fetch(`http://127.0.0.1:${fresh.port}/health`);
      if (health.ok) {
        if (fresh.port !== port) {
          // The requested port was taken; repoint the overlay so config.toml
          // matches the port the daemon actually bound.
          const configPath = path.join(codexHome, 'config.toml');
          if (fs.existsSync(configPath)) {
            const config = fs.readFileSync(configPath, 'utf8');
            const needle = `http://127.0.0.1:${port}/v1`;
            if (config.split(needle).length === 2) {
              fs.writeFileSync(configPath, config.replace(needle, `http://127.0.0.1:${fresh.port}/v1`));
              console.log(`Port ${port} was taken; repointed config.toml to ${fresh.port}.`);
            } else {
              console.warn(`Port changed to ${fresh.port} but config.toml does not contain exactly one ${needle}; update its base_url manually.`);
            }
          }
        }
        console.log(`Codex bridge restarted on http://127.0.0.1:${fresh.port}/v1 (provider: ${provider}, models: ${models.length}).`);
        console.log(`Codex can send messages again. Logs: ${logFile}`);
        return;
      }
    }
    if (!processAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  throw new Error(`The bridge daemon did not become healthy. Check ${logFile}.`);
}

main().catch((error) => { console.error(`restart-codex-bridge: ${error.message}`); process.exitCode = 1; });
