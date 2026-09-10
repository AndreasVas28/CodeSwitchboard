'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TARGET_CATALOG, catalogTarget } = require('./target-catalog');

const COMMANDS = {
  'codex-cli': 'codex', 'opencode-cli': 'opencode', 'aider-cli': 'aider', 'claude-cli': 'claude',
  'pi-cli': 'pi', 'cline-cli': 'cline', 'dsh-cli': 'dsh', 'hermes-cli': 'hermes', 'gemini-cli': 'gemini',
  'crush-cli': 'crush', 'qwen-cli': 'qwen', 'kilo-cli': 'kilo',
  'copilot-cli': 'copilot'
};

const APP_CANDIDATES = {
  'vscode-app': ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'],
};

const RECOMMENDED = ['crush-cli', 'qwen-cli', 'kilo-cli'];

function expandWindowsPath(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || process.env[name.toUpperCase()] || `%${name}%`);
}

function resolveCommand(command) {
  if (!command) return null;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  if (lookup.status !== 0) return null;
  const matches = String(lookup.stdout || '').split(/\r?\n/).filter(Boolean);
  if (process.platform !== 'win32') return matches[0] || null;
  return matches.find((item) => /\.exe$/i.test(item)) || matches.find((item) => /\.(cmd|bat)$/i.test(item)) || matches[0] || null;
}

function executableFor(target) {
  const candidates = (APP_CANDIDATES[target.id] || []).map(expandWindowsPath);
  // Prefer known app/adapter paths so a Windows .cmd shim does not hide the
  // real desktop executable and so bundled CLI shims are detected consistently.
  const candidate = candidates.find((item) => fs.existsSync(item));
  if (candidate) return candidate;
  const command = COMMANDS[target.id];
  return resolveCommand(command);
}

function versionOf(executable) {
  if (!executable) return null;
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: /\.(cmd|bat)$/i.test(executable) });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].slice(0, 200) || null;
}

function detectCatalog(targets = TARGET_CATALOG, { includeVersion = false } = {}) {
  return targets.map((target) => {
    const executable = executableFor(target);
    return {
      ...target,
      kind: target.surface.includes('cli') ? 'cli' : target.surface === 'extension' ? 'extension' : 'app',
      command: COMMANDS[target.id] || undefined,
      candidates: APP_CANDIDATES[target.id] || undefined,
      installed: Boolean(executable),
      executable,
      version: includeVersion && target.surface.includes('cli') ? versionOf(executable) : null,
      installable: Boolean(target.install?.length),
      launchable: ['verified', 'implemented'].includes(target.implementation) && target.mode !== 'extension' && target.mode !== 'wsl-container',
      verificationStatus: target.verificationStatus || (target.implementation === 'verified' ? 'verified' : 'unverified')
    };
  });
}

function availableStrategy(target) {
  for (const strategy of target.install || []) {
    const executable = resolveCommand(strategy.command);
    if (executable) return { ...strategy, executable };
  }
  return null;
}

function installPlan(ids = RECOMMENDED) {
  return ids.map((id) => {
    const target = catalogTarget(id);
    if (!target) return { id, error: 'Unknown target.' };
    const strategy = availableStrategy(target);
    return {
      id, name: target.name, alreadyInstalled: Boolean(executableFor(target)),
      strategy: strategy ? { type: strategy.type, package: strategy.package, command: strategy.command, args: strategy.args } : null,
      error: strategy ? null : 'No supported installer is available on this PC.'
    };
  });
}

function prepareInstaller(target, strategy, update) {
  const args = [...strategy.args];
  if (update) {
    if (strategy.type === 'winget') args[0] = 'upgrade';
    if (strategy.type === 'npm' && !args.some((arg) => /@latest$/i.test(arg))) args[args.length - 1] = `${args[args.length - 1]}@latest`;
  }
  let installerExecutable = strategy.executable;
  let installerArgs = args;
  if (/npm\.cmd$/i.test(strategy.executable)) {
    const npmCli = path.join(path.dirname(strategy.executable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const bundledNode = path.join(path.dirname(strategy.executable), 'node.exe');
    if (!fs.existsSync(npmCli)) throw new Error(`The npm launcher was found, but npm-cli.js is missing beside it: ${strategy.executable}`);
    installerExecutable = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
    installerArgs = [npmCli, ...args];
  }
  return { installerExecutable, installerArgs };
}

function installationReceipt(target, strategy, update) {
  const executable = executableFor(target);
  if (!executable) throw new Error(`${target.name} installer completed, but ${COMMANDS[target.id] || 'its executable'} was not found in a clean PATH scan. Open a new PowerShell and run csb doctor ${target.id}.`);
  return { targetId: target.id, status: update ? 'updated' : 'installed', installer: strategy.type, package: strategy.package, executable, version: versionOf(executable) };
}

function installTarget(id, { update = false } = {}) {
  const target = catalogTarget(id);
  if (!target) throw new Error(`Unknown target: ${id}`);
  const before = executableFor(target);
  if (before && !update) return { targetId: id, status: 'already-installed', executable: before, version: versionOf(before) };
  const strategy = availableStrategy(target);
  if (!strategy) throw new Error(`${target.name} has no supported automatic installer on this PC. Use its official documentation: ${target.docs}`);
  const { installerExecutable, installerArgs } = prepareInstaller(target, strategy, update);
  const result = spawnSync(installerExecutable, installerArgs, { encoding: 'utf8', windowsHide: false, timeout: 10 * 60_000, shell: false });
  if (result.error) throw new Error(`${target.name} installer could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${target.name} installation failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-2000)}`);
  return installationReceipt(target, strategy, update);
}

function installTargetAsync(id, { update = false } = {}) {
  const target = catalogTarget(id);
  if (!target) return Promise.reject(new Error(`Unknown target: ${id}`));
  const before = executableFor(target);
  if (before && !update) return Promise.resolve({ targetId: id, status: 'already-installed', executable: before, version: versionOf(before) });
  const strategy = availableStrategy(target);
  if (!strategy) return Promise.reject(new Error(`${target.name} has no supported automatic installer on this PC. Use its official documentation: ${target.docs}`));
  const { installerExecutable, installerArgs } = prepareInstaller(target, strategy, update);
  return new Promise((resolve, reject) => {
    const child = spawn(installerExecutable, installerArgs, { windowsHide: false, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${target.name} installation timed out after 10 minutes.`));
    }, 10 * 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`${target.name} installer could not start: ${error.message}`)); });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) return reject(new Error(`${target.name} installation failed (${status}): ${(stderr || stdout).trim().slice(-2000)}`));
      try { resolve(installationReceipt(target, strategy, update)); } catch (error) { reject(error); }
    });
  });
}

function doctorTarget(id) {
  const target = catalogTarget(id);
  if (!target) throw new Error(`Unknown target: ${id}`);
  const executable = executableFor(target);
  const issues = [];
  if (target.windows === 'wsl' && !resolveCommand('wsl.exe')) issues.push('WSL is required but was not detected.');
  if (target.windows === 'container' && !resolveCommand('docker.exe')) issues.push('Docker is required but was not detected.');
  if (!executable && target.surface.includes('cli')) issues.push(`${COMMANDS[id] || target.name} was not found on PATH.`);
  if (!executable && target.surface === 'desktop') issues.push('Desktop executable was not found in a known installation path.');
  if (target.vendorLogin) issues.push(`Requires a ${target.name} vendor account or service credential; CodeSwitchboard will not bypass it.`);
  if (!['verified', 'implemented'].includes(target.implementation)) issues.push(`Adapter status is ${target.implementation}; provider routing is not enabled.`);
  if (target.verificationStatus && target.verificationStatus !== 'verified') issues.push(`Inference verification status: ${target.verificationStatus}. A detected executable is not proof of a working provider route.`);
  return { targetId: id, name: target.name, healthy: issues.length === 0, installed: Boolean(executable), executable, version: versionOf(executable), mode: target.mode, implementation: target.implementation, verificationStatus: target.verificationStatus || (target.implementation === 'verified' ? 'verified' : 'unverified'), issues, docs: target.docs };
}

module.exports = { COMMANDS, APP_CANDIDATES, RECOMMENDED, detectCatalog, executableFor, installPlan, installTarget, installTargetAsync, doctorTarget, versionOf };
