#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = 'http://127.0.0.1:4242';
const SERVER = path.join(__dirname, 'codeswitchboard-server.js');

function usage() {
  console.log(`CodeSwitchboard CLI

Usage:
  csb server                         Run the local dashboard server
  csb open                           Start and open the dashboard
  csb stop                           Stop the dashboard and active bridges
  csb info                           Show saved selections and connections
  csb providers                      List providers
  csb targets                        List installed apps and CLIs
  csb catalog [--mode <mode>]        List the complete compatibility catalog
  csb target info <id>               Show target details and official docs
  csb install <id>                   Install one target from an official source
  csb install --recommended [--yes]  Preview/install routed Windows targets
  csb update <id|--installed>        Update one or all installed targets
  csb doctor [target]                Diagnose installation and routing status
  csb test <target|--routed>         Send a test or run local routed fixtures
  csb uninstall-routing <target>     Remove CodeSwitchboard-owned routing
  csb models [provider]              List models from a provider
  csb key set <provider> [key]       Save a DPAPI-encrypted provider key
  csb key remove <provider>          Remove a saved provider key
  csb select provider <id>           Save the default provider
  csb select model <id>              Save the default model
  csb select target <id>             Save the default app or CLI
  csb select workspace <path>        Save the default workspace
  csb launch [target] [options]      Launch using saved defaults
  csb uninstall [--purge] [--keep-apps] [--yes]
                                 Restore apps, stop the server, and remove the
                                 global csb command; --purge also deletes saved
                                 settings and bridge state
  csb restore claude|codex           Restore the app's normal account

Launch options:
  --provider <id>  --model <id>  --workspace <path>`);
}

async function request(route, options = {}) {
  const response = await fetch(`${ROOT}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function serverAvailable() {
  try { await request('/api/state'); return true; } catch { return false; }
}

async function ensureServer() {
  if (await serverAvailable()) return;
  const child = spawn(process.execPath, [SERVER, '--no-open'], {
    cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await serverAvailable()) return;
  }
  throw new Error('CodeSwitchboard server did not start on http://127.0.0.1:4242.');
}

async function readSecret(label) {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value.trim();
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    process.stdin.on('data', function onData(chunk) {
      const text = chunk.toString('utf8');
      if (text === '\u0003') { finish(); process.stdin.off('data', onData); reject(new Error('Cancelled.')); return; }
      if (text.includes('\r') || text.includes('\n')) { finish(); process.stdin.off('data', onData); resolve(value.trim()); return; }
      if (text === '\u007f' || text === '\b') { value = value.slice(0, -1); return; }
      value += text;
    });
  });
}

function parseLaunch(args) {
  const result = {};
  if (args[0] && !args[0].startsWith('--')) result.targetId = args.shift();
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === '--provider') result.providerId = value;
    else if (flag === '--model') result.model = value;
    else if (flag === '--workspace') result.workspace = value;
    else throw new Error(`Unknown launch option: ${flag}`);
  }
  return result;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} `);
  process.stdin.resume();
  try {
    for await (const chunk of process.stdin) {
      const answer = chunk.toString().trim().toLowerCase();
      return answer === '' || answer === 'y' || answer === 'yes';
    }
  } finally { process.stdin.pause(); }
  return false;
}

async function stopServer() {
  if (!await serverAvailable()) return false;
  await request('/api/shutdown', { method: 'POST', body: '{}' });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await serverAvailable()) await new Promise((resolve) => setTimeout(resolve, 100));
  if (await serverAvailable()) throw new Error('The server did not stop within 5 seconds.');
  return true;
}

function npmCommand() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

function removeGlobalCommand() {
  const result = spawnSync(npmCommand(), ['uninstall', '-g', 'codeswitchboard'], { encoding: 'utf8', shell: false });
  if (result.status !== 0) console.log(`npm uninstall -g codeswitchboard failed (${(result.stderr || result.stdout || '').trim().split('\n')[0]}); removing the command files directly.`);
  const prefixResult = spawnSync(npmCommand(), ['prefix', '-g'], { encoding: 'utf8', shell: false });
  if (prefixResult.status !== 0 || !prefixResult.stdout) return;
  const prefix = prefixResult.stdout.trim();
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const modulesDir = path.join(prefix, 'node_modules', 'codeswitchboard');
  const owned = ['csb', 'codeswitchboard', 'codeswitchboard-server', 'free-codex'];
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.ps1'] : [''];
  let removed = 0;
  for (const name of owned) {
    for (const extension of extensions) {
      const file = path.join(binDir, name + extension);
      if (fs.existsSync(file)) { try { fs.rmSync(file, { force: true }); removed++; } catch { /* keep going */ } }
    }
  }
  if (fs.existsSync(modulesDir)) { try { fs.rmSync(modulesDir, { recursive: true, force: true }); removed++; } catch { /* keep going */ } }
  if (removed) console.log(`Removed ${removed} leftover command file${removed === 1 ? '' : 's'} from ${binDir}.`);
}

function restoreAppsDirectly() {
  const warnings = [];
  const legacyLauncher = path.join(__dirname, 'free-codex.js');
  const codex = spawnSync(process.execPath, [legacyLauncher, 'launch', 'codex-app', '--restore'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (codex.status === 0) console.log((codex.stdout || 'Codex restored to its normal account configuration.').trim());
  else warnings.push(`Codex restore skipped: ${(codex.stderr || codex.stdout || `exit ${codex.status}`).trim().split('\n')[0]}`);
  try {
    const { TargetLauncher } = require('../lib/target-registry');
    const result = new TargetLauncher({ legacyLauncherPath: legacyLauncher }).restoreClaudeDesktop();
    console.log(result.message);
  } catch (error) {
    warnings.push(`Claude Desktop restore skipped: ${error.message.split('\n')[0]}`);
  }
  return warnings;
}

function purgeSavedState() {
  const removed = [];
  try {
    const { defaultStorePath } = require('../lib/persistent-store');
    const settings = defaultStorePath();
    if (fs.existsSync(settings)) { fs.rmSync(settings, { force: true }); removed.push(settings); }
  } catch { /* settings path unavailable; skip */ }
  const codexHome = path.join(os.homedir(), '.codex');
  for (const name of ['free-codex-launch.json', 'free-codex-bridge.log', 'free-codex-nvidia-models.json', 'config.toml.free-codex-backup']) {
    const file = path.join(codexHome, name);
    if (fs.existsSync(file)) { try { fs.rmSync(file, { force: true }); removed.push(file); } catch { /* keep going */ } }
  }
  const backups = path.join(codexHome, 'free-codex-backups');
  if (fs.existsSync(backups)) { try { fs.rmSync(backups, { recursive: true, force: true }); removed.push(backups); } catch { /* keep going */ } }
  for (const item of removed) console.log(`Removed ${item}`);
  return removed.length;
}

async function main(argv = process.argv.slice(2)) {
  const [command = 'info', ...args] = argv;
  if (['help', '--help', '-h'].includes(command)) { usage(); return; }
  if (command === 'stop') {
    if (await stopServer()) console.log('CodeSwitchboard stopped.');
    else console.log('CodeSwitchboard is already stopped.');
    return;
  }
  if (command === 'uninstall') {
    const purge = args.includes('--purge');
    const keepApps = args.includes('--keep-apps');
    const assumeYes = args.includes('--yes');
    const unknown = args.filter((flag) => !['--purge', '--keep-apps', '--yes'].includes(flag));
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}. Use: csb uninstall [--purge] [--keep-apps] [--yes]`);
    if (!assumeYes) {
      const summary = [`Restore Codex and Claude Desktop to their normal accounts`, 'stop the dashboard', 'remove the global csb command'];
      if (purge) summary.push('delete saved settings and bridge state');
      if (!await confirm(`Uninstall CodeSwitchboard? This will ${summary.join(', ')}. Continue? [Y/n]`)) { console.log('Cancelled.'); return; }
    }
    const serverWasRunning = await serverAvailable();
    if (keepApps) console.log('Skipping app restore (--keep-apps).');
    else if (serverWasRunning) {
      for (const app of ['codex', 'claude']) {
        try { const result = await request(`/api/restore-${app}`, { method: 'POST', body: '{}' }); console.log(result.message); }
        catch (error) { console.log(`${app === 'codex' ? 'Codex' : 'Claude Desktop'} restore skipped: ${error.message.split('\n')[0]}`); }
      }
    } else {
      console.log('Server is not running; restoring apps directly.');
      for (const warning of restoreAppsDirectly()) console.log(warning);
    }
    if (await stopServer()) console.log('CodeSwitchboard stopped.');
    removeGlobalCommand();
    if (purge) purgeSavedState();
    else console.log(`Saved settings were kept. Delete them later with: csb uninstall --purge --yes${serverWasRunning ? '' : ''}`);
    console.log('CodeSwitchboard uninstalled. You can delete this repository folder whenever you like.');
    return;
  }
  if (command === 'server') {
    const child = spawn(process.execPath, [SERVER, ...args], { cwd: process.cwd(), stdio: 'inherit', windowsHide: false });
    child.on('exit', (code) => { process.exitCode = code || 0; });
    return;
  }
  await ensureServer();

  if (command === 'open') {
    if (process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${ROOT}'`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, [ROOT], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    console.log(`Opened ${ROOT}`);
    return;
  }

  if (command === 'info' || command === 'status') {
    const state = await request('/api/state');
    const saved = state.preferences || {};
    console.log(`Server:   ${ROOT}`);
    console.log(`Provider: ${saved.providerId || '(not selected)'}`);
    console.log(`Model:    ${saved.model || '(not selected)'}`);
    console.log(`Target:   ${saved.targetId || '(not selected)'}`);
    console.log(`Workspace:${saved.workspace ? ` ${saved.workspace}` : ' (not selected)'}`);
    console.log(`Keys:     ${state.providers.filter((item) => item.keyConfigured).map((item) => `${item.id} (${item.keySource})`).join(', ') || '(none)'}`);
    return;
  }

  if (command === 'providers') {
    const state = await request('/api/state');
    for (const item of state.providers) console.log(`${item.keyConfigured ? '*' : ' '} ${item.id.padEnd(12)} ${item.name}`);
    return;
  }

  if (command === 'targets') {
    const state = await request('/api/state');
    for (const item of state.targets) console.log(`${item.installed ? '*' : ' '} ${item.id.padEnd(18)} ${item.name}`);
    return;
  }

  if (command === 'catalog') {
    const modeIndex = args.indexOf('--mode');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : '';
    if (modeIndex >= 0 && !mode) throw new Error('--mode requires a value.');
    const result = await request(`/api/catalog${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`);
    for (const item of result.catalog) {
      console.log(`${item.installed ? '*' : ' '} ${item.id.padEnd(20)} ${item.mode.padEnd(16)} ${item.windows.padEnd(9)} ${item.implementation.padEnd(12)} ${item.name}`);
    }
    return;
  }

  if (command === 'target') {
    const [action, id] = args;
    if (action !== 'info' || !id) throw new Error('Use: csb target info <target-id>');
    const result = await request(`/api/targets/${encodeURIComponent(id)}`);
    const item = result.target;
    console.log(`${item.name} (${item.id})`);
    console.log(`Mode:       ${item.mode}`);
    console.log(`Windows:    ${item.windows}`);
    console.log(`Adapter:    ${item.implementation}`);
    console.log(`Installed:  ${item.installed ? 'yes' : 'no'}`);
    console.log(`Version:    ${item.version || '(unavailable)'}`);
    console.log(`Installable:${item.installable ? ' yes' : ' no automatic installer'}`);
    console.log(`Docs:       ${item.docs}`);
    return;
  }

  if (command === 'install') {
    if (args[0] === '--recommended') {
      const plan = (await request('/api/install-plan')).plan;
      console.log('Recommended provider-routed Windows targets:');
      for (const item of plan) console.log(`  ${item.alreadyInstalled ? '*' : ' '} ${item.id}: ${item.alreadyInstalled ? 'already installed' : item.strategy ? `${item.strategy.type} ${item.strategy.package}` : item.error}`);
      if (!args.includes('--yes')) { console.log('Preview only. Run csb install --recommended --yes to install missing targets.'); return; }
      for (const item of plan.filter((entry) => !entry.alreadyInstalled && entry.strategy)) {
        console.log(`Installing ${item.name}…`);
        const result = await request(`/api/targets/${encodeURIComponent(item.id)}/install`, { method: 'POST', body: '{}' });
        console.log(`${result.receipt.status}: ${item.name} ${result.receipt.version || ''}`.trim());
      }
      return;
    }
    const id = args[0];
    if (!id) throw new Error('Use: csb install <target-id>');
    const result = await request(`/api/targets/${encodeURIComponent(id)}/install`, { method: 'POST', body: '{}' });
    console.log(`${result.receipt.status}: ${result.target.name}${result.receipt.version ? ` (${result.receipt.version})` : ''}`);
    return;
  }

  if (command === 'update') {
    const id = args[0];
    if (id !== '--installed') {
      if (!id) throw new Error('Use: csb update <target-id|--installed>');
      const result = await request(`/api/targets/${encodeURIComponent(id)}/install`, { method: 'POST', body: JSON.stringify({ update: true }) });
      console.log(`${result.receipt.status}: ${result.target.name}${result.receipt.version ? ` (${result.receipt.version})` : ''}`);
      return;
    }
    const catalog = (await request('/api/catalog')).catalog.filter((item) => item.installed && item.installable);
    if (!catalog.length) { console.log('No installed targets have an automatic updater.'); return; }
    console.log(`Updating ${catalog.length} installed target${catalog.length === 1 ? '' : 's'}…`);
    let failed = false;
    for (const item of catalog) {
      try {
        const result = await request(`/api/targets/${encodeURIComponent(item.id)}/install`, { method: 'POST', body: JSON.stringify({ update: true }) });
        console.log(`${result.receipt.status}: ${item.name}${result.receipt.version ? ` (${result.receipt.version})` : ''}`);
      } catch (error) {
        failed = true;
        console.error(`failed: ${item.name}: ${error.message}`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (command === 'doctor') {
    const ids = args[0] ? [args[0]] : (await request('/api/catalog')).catalog.filter((item) => item.installed || item.launchable).map((item) => item.id);
    let failed = false;
    for (const id of ids) {
      const result = await request(`/api/targets/${encodeURIComponent(id)}/doctor`);
      console.log(`${result.healthy ? 'OK' : '!!'} ${result.name}: ${result.version || (result.installed ? 'installed' : 'not installed')} [${result.implementation}/${result.verificationStatus || 'unverified'}]`);
      for (const issue of result.issues) console.log(`   - ${issue}`);
      failed ||= !result.healthy;
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (command === 'test') {
    if (args[0] === '--routed') {
      const script = path.join(__dirname, '..', 'scripts', 'verify-target-messages.js');
      const child = spawn(process.execPath, [script], { cwd: process.cwd(), stdio: 'inherit', windowsHide: false });
      child.on('exit', (code) => { process.exitCode = code || 0; });
      return;
    }
    const targetId = args[0];
    if (!targetId) throw new Error('Use: csb test <target-id> or csb test --routed');
    const state = await request('/api/state');
    const saved = state.preferences || {};
    if (!saved.providerId || !saved.model) throw new Error('Select a provider and model first. This command sends one short live provider request.');
    const result = await request('/api/test-target', { method: 'POST', body: JSON.stringify({ providerId: saved.providerId, targetId, model: saved.model, workspace: saved.workspace || state.workspace, prompt: 'Reply with exactly CODESWITCHBOARD_OK and do not use tools.' }) });
    console.log(result.output);
    return;
  }

  if (command === 'uninstall-routing') {
    const id = args[0];
    if (!id) throw new Error('Use: csb uninstall-routing <target-id>');
    const result = await request(`/api/targets/${encodeURIComponent(id)}/uninstall-routing`, { method: 'POST', body: '{}' });
    console.log(result.message);
    return;
  }

  if (command === 'models') {
    const state = await request('/api/state');
    const providerId = args[0] || state.preferences?.providerId;
    if (!providerId) throw new Error('Choose a provider: csb models nvidia');
    const result = await request(`/api/providers/${encodeURIComponent(providerId)}/models`);
    result.models.forEach((model) => console.log(model));
    return;
  }

  if (command === 'key') {
    const [action, providerId, supplied] = args;
    if (!providerId || !['set', 'remove'].includes(action)) throw new Error('Use: csb key set <provider> [key] or csb key remove <provider>');
    if (action === 'remove') {
      await request(`/api/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
      console.log(`Removed saved ${providerId} key.`);
      return;
    }
    const apiKey = supplied || await readSecret(`${providerId} API key: `);
    if (!apiKey) throw new Error('The API key cannot be empty.');
    await request(`/api/providers/${encodeURIComponent(providerId)}`, { method: 'PUT', body: JSON.stringify({ apiKey }) });
    console.log(`Saved ${providerId} key encrypted for this Windows user.`);
    return;
  }

  if (command === 'select') {
    const [kind, ...rest] = args;
    const key = { provider: 'providerId', model: 'model', target: 'targetId', workspace: 'workspace' }[kind];
    const value = rest.join(' ').trim();
    if (!key || !value) throw new Error('Use: csb select provider|model|target|workspace <value>');
    await request('/api/preferences', { method: 'PUT', body: JSON.stringify({ [key]: value }) });
    console.log(`Saved ${kind}: ${value}`);
    return;
  }

  if (command === 'launch') {
    const overrides = parseLaunch([...args]);
    const state = await request('/api/state');
    const saved = state.preferences || {};
    const body = {
      providerId: overrides.providerId || saved.providerId,
      targetId: overrides.targetId || saved.targetId,
      model: overrides.model || saved.model,
      workspace: overrides.workspace || saved.workspace || state.workspace
    };
    if (!body.targetId) throw new Error('No target selected. Use csb select target <id> or csb launch <id>.');
    const result = await request('/api/launch', { method: 'POST', body: JSON.stringify(body) });
    console.log(result.message);
    return;
  }

  if (command === 'restore') {
    const app = String(args[0] || '').toLowerCase();
    if (!['claude', 'codex'].includes(app)) throw new Error('Use: csb restore claude|codex');
    const result = await request(`/api/restore-${app}`, { method: 'POST', body: '{}' });
    console.log(result.message);
    return;
  }

  throw new Error(`Unknown command: ${command}. Run csb help.`);
}

if (require.main === module) main().catch((error) => { console.error(`csb: ${error.message}`); process.exitCode = 1; });

module.exports = { main, parseLaunch };
