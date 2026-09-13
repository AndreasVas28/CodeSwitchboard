'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function defaultStorePath() {
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'CodeSwitchboard', 'config.json');
  }
  // XDG-style path on macOS and Linux (the state directory, not cache).
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdg, 'codeswitchboard', 'config.json');
}

function runDpapi(mode, value) {
  if (process.platform !== 'win32') {
    // Non-Windows fallback: keys stay in the store file, protected by the
    // owner-only permissions applied in save(). No Windows DPAPI available.
    return String(value);
  }
  const protect = mode === 'protect';
  const script = protect
    ? "Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($sealed))"
    : "Add-Type -AssemblyName System.Security;$sealed=[Convert]::FromBase64String([Console]::In.ReadToEnd());$bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: String(value), encoding: 'utf8', windowsHide: true, timeout: 15_000
  });
  if (result.status !== 0) throw new Error(`Windows could not ${protect ? 'encrypt' : 'decrypt'} the provider key: ${(result.stderr || `exit ${result.status}`).trim()}`);
  return String(result.stdout || '');
}

class PersistentStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
    this.data = { version: 1, encryptedKeys: {}, providerOverrides: {}, selections: {}, targetReceipts: {} };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && parsed.version === 1) this.data = { ...this.data, ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[store] ignoring unreadable configuration', { file: this.filePath, error: error.message });
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  keys() {
    const result = {};
    for (const [providerId, stored] of Object.entries(this.data.encryptedKeys || {})) {
      const atRest = typeof stored === 'string' ? (stored.match(/^(dpapi:|plaintext:)/) || [])[1] || 'dpapi:' : 'dpapi:';
      const encrypted = String(stored).slice(atRest.length);
      try { result[providerId] = runDpapi(atRest === 'plaintext:' ? 'passthrough' : 'unprotect', encrypted); }
      catch (error) { console.warn('[store] could not decrypt provider key', { providerId, error: error.message }); }
    }
    return result;
  }

  setKey(providerId, apiKey) {
    if (apiKey) {
      const stored = runDpapi('protect', apiKey);
      const atRest = process.platform === 'win32' ? 'dpapi:' : 'plaintext:';
      this.data.encryptedKeys[providerId] = atRest + stored;
    } else delete this.data.encryptedKeys[providerId];
    this.save();
  }

  setProviderOverride(providerId, override) {
    if (override) this.data.providerOverrides[providerId] = override;
    else delete this.data.providerOverrides[providerId];
    this.save();
  }

  updateSelections(values) {
    this.data.selections = { ...this.data.selections, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
    this.save();
  }

  selections() { return { ...(this.data.selections || {}) }; }
  providerOverrides() { return { ...(this.data.providerOverrides || {}) }; }

  setTargetReceipt(targetId, receipt) {
    if (receipt) this.data.targetReceipts[targetId] = { ...receipt };
    else delete this.data.targetReceipts[targetId];
    this.save();
  }

  setTargetVerification(targetId, verification) {
    const existing = this.data.targetReceipts[targetId] || {};
    this.data.targetReceipts[targetId] = { ...existing, verification: { ...verification } };
    this.save();
  }

  targetReceipts() { return { ...(this.data.targetReceipts || {}) }; }
}

module.exports = { PersistentStore, defaultStorePath, runDpapi };
