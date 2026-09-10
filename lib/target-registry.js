'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startBridge } = require('./responses-bridge');
const { startAnthropicBridge, claudeDesktopModelEntries } = require('./anthropic-bridge');
const { startGeminiBridge } = require('./gemini-bridge');
const { catalogTarget } = require('./target-catalog');

function windowsQuote(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function launchOutsideCodexJob(executable, args, payload) {
  const token = crypto.randomBytes(24).toString('hex');
  let deliveredResolve;
  let deliveredReject;
  const delivered = new Promise((resolve, reject) => { deliveredResolve = resolve; deliveredReject = reject; });
  const handoff = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== `/${token}`) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = JSON.stringify(payload);
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    response.end(body, () => {
      deliveredResolve();
      handoff.close();
    });
  });
  handoff.on('error', deliveredReject);
  await new Promise((resolve, reject) => {
    handoff.once('error', reject);
    handoff.listen(0, '127.0.0.1', resolve);
  });

  const handoffUrl = `http://127.0.0.1:${handoff.address().port}/${token}`;
  const commandLine = [executable, ...args, '--handoff-url', handoffUrl].map(windowsQuote).join(' ');
  const encoded = Buffer.from(commandLine, 'utf8').toString('base64');
  const script = `$line=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line}; if ($result.ReturnValue -ne 0) { exit $result.ReturnValue }`;
  const started = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (started.status !== 0) {
    handoff.close();
    throw new Error(`Windows could not start the independent Codex launcher: ${(started.stderr || started.stdout || `exit ${started.status}`).trim()}`);
  }

  const timeout = setTimeout(() => deliveredReject(new Error('The independent Codex launcher did not collect its secure handoff.')), 15000);
  try { await delivered; } finally { clearTimeout(timeout); handoff.close(); }
}

const BASE_TARGETS = [
  { id: 'codex-desktop', name: 'Codex Desktop', kind: 'app', command: 'codex', routing: 'bridge', modelCommand: 'Codex model picker', modelSwitch: 'Native Codex model picker', description: 'Real Codex app with provider and model routing.' },
  { id: 'codex-cli', name: 'Codex CLI', kind: 'cli', command: 'codex', routing: 'bridge', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Codex terminal agent through the local bridge. Codex receives the native terminal directly so typing remains responsive.' },
  { id: 'opencode-cli', name: 'OpenCode', kind: 'cli', command: 'opencode', routing: 'compatible', modelCommand: '/models', modelSwitch: 'Native /models picker', description: 'OpenAI-compatible provider configuration generated per launch.' },
  { id: 'aider-cli', name: 'Aider', kind: 'cli', command: 'aider', routing: 'compatible', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', candidates: ['%USERPROFILE%\\.local\\bin\\aider.exe'], description: 'OpenAI-compatible model and endpoint passed at launch. Aider receives the native terminal directly so typing remains responsive.' },
  { id: 'claude-cli', name: 'Claude Code', kind: 'cli', command: 'claude', routing: 'anthropic', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Claude Code routed through the selected provider without Anthropic login. Claude receives the native terminal directly so typing remains responsive.' },
  { id: 'claude-app', name: 'Claude Desktop', kind: 'app', routing: 'anthropic', modelCommand: 'Claude model picker', modelSwitch: 'Native Claude Desktop model picker', candidates: ['%LOCALAPPDATA%\\AnthropicClaude\\claude.exe', '%LOCALAPPDATA%\\Programs\\Claude Code\\claude.exe'], description: 'The Claude desktop app routed through the selected provider without Anthropic login.' },
  { id: 'pi-cli', name: 'Pi', kind: 'cli', command: 'pi', routing: 'anthropic', modelCommand: '/models', modelSwitch: 'CodeSwitchboard extension picker', description: 'Pi Coding Agent with an ephemeral CodeSwitchboard provider.' },
  { id: 'cline-cli', name: 'Cline', kind: 'cli', command: 'cline', routing: 'bridge', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Cline CLI with isolated provider and model files for this launch. Cline receives the native terminal directly so typing and approvals remain responsive.' },
  { id: 'dsh-cli', name: 'DeepSeek Harness Web', kind: 'cli', command: 'dsh', routing: 'bridge', modelCommand: '/models', modelSwitch: 'Native /models picker', description: 'DeepSeek Harness with a temporary CodeSwitchboard profile patch.' },
  { id: 'hermes-cli', name: 'Hermes Agent', kind: 'cli', command: 'hermes', routing: 'bridge', modelCommand: '/model', modelSwitch: 'Native /model command in classic CLI mode', candidates: ['%LOCALAPPDATA%\\hermes\\bin\\hermes.exe', '%USERPROFILE%\\AppData\\Local\\hermes\\bin\\hermes.exe'], description: 'Hermes Agent routed through the local Responses bridge in its documented classic CLI mode.' },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'cli', command: 'gemini', routing: 'gemini', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Gemini CLI routed through a local Gemini-protocol bridge without Google sign-in. Gemini receives the native terminal directly so typing remains responsive.' },
  { id: 'vscode-app', name: 'Visual Studio Code', kind: 'app', command: 'code', routing: 'editor', candidates: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'], description: 'Opens the selected workspace.' },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI', kind: 'cli', command: 'copilot', routing: 'native-account', modelCommand: 'Copilot model picker', modelSwitch: 'Native GitHub Copilot model picker', description: 'Opens GitHub Copilot CLI using its own GitHub account and subscription.' },

];

const NEW_TARGETS = [
  { id: 'crush-cli', name: 'Crush', kind: 'cli', command: 'crush', routing: 'gateway-compatible', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Open-source coding agent using an isolated custom OpenAI-compatible provider. Crush receives the native terminal directly so typing remains responsive.' },
  { id: 'qwen-cli', name: 'Qwen Code', kind: 'cli', command: 'qwen', routing: 'gateway-compatible', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Qwen Code with an isolated provider catalog. Qwen receives the native terminal directly so typing remains responsive.' },
  { id: 'kilo-cli', name: 'Kilo Code CLI', kind: 'cli', command: 'kilo', routing: 'gateway-compatible', modelCommand: 'Dashboard model picker', modelSwitch: 'CodeSwitchboard dashboard picker; relaunch to apply', description: 'Kilo CLI with an in-memory OpenAI-compatible provider configuration. Kilo receives the native terminal directly so typing remains responsive.' }
];

const TARGETS = [...BASE_TARGETS, ...NEW_TARGETS]
  .reduce((unique, target) => unique.some((item) => item.id === target.id) ? unique : [...unique, target], [])
  .map((target) => ({ ...(catalogTarget(target.id) || {}), ...target }));

function resolveCommand(command) {
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  if (lookup.status !== 0) return null;
  const matches = lookup.stdout.split(/\r?\n/).filter(Boolean);
  if (process.platform !== 'win32') return matches[0] || null;
  return matches.find((item) => /\.exe$/i.test(item))
    || matches.find((item) => /\.cmd$/i.test(item))
    || matches.find((item) => /\.bat$/i.test(item))
    || matches.find((item) => /\.ps1$/i.test(item))
    || matches[0]
    || null;
}

function expandWindowsPath(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || process.env[name.toUpperCase()] || `%${name}%`);
}

function resolveTargetExecutable(target) {
  const candidatePaths = (target.candidates || []).map(expandWindowsPath);
  if (target.kind === 'app') {
    const app = candidatePaths.find((candidate) => fs.existsSync(candidate));
    if (app) return app;
  }
  const command = target.command ? resolveCommand(target.command) : null;
  if (command) return command;
  for (const expanded of candidatePaths) {
    if (fs.existsSync(expanded)) return expanded;
  }
  return null;
}

function codexDesktopInstalled() {
  if (process.platform !== 'win32') return Boolean(resolveCommand('codex'));
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Get-AppxPackage -Name OpenAI.Codex) { exit 0 } else { exit 1 }'], { windowsHide: true }).status === 0;
}

function claudeDesktopExecutable() {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "$package = Get-AppxPackage | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1; if ($package) { Write-Output $package.InstallLocation; exit 0 }; exit 1"], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (result.status === 0) {
      const install = String(result.stdout || '').trim();
      for (const relative of ['app\\Claude.exe', 'Claude.exe']) {
        const appExe = install ? path.join(install, relative) : '';
        if (appExe && fs.existsSync(appExe)) return appExe;
      }
    }
  }
  const claudeApp = TARGETS.find((target) => target.id === 'claude-app');
  for (const candidate of (claudeApp?.candidates || []).map(expandWindowsPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const CLAUDE_POLICY_KEY = 'HKCU\\SOFTWARE\\Policies\\Claude';
const CLAUDE_POLICY_MARKER = 'CodeSwitchboardManaged';
const CLAUDE_DESKTOP_BRIDGE_PORT = 4243;

function claudeDesktopPolicyEntries(localRoot, models = ['claude-sonnet-4-6']) {
  const modelList = [...new Set(models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim()))];
  const desktopModels = claudeDesktopModelEntries(modelList.length ? modelList : ['claude-sonnet-4-6']);
  return [
    ['inferenceProvider', 'REG_SZ', 'gateway'],
    ['inferenceCredentialKind', 'REG_SZ', 'static'],
    ['inferenceGatewayBaseUrl', 'REG_SZ', localRoot],
    ['inferenceGatewayApiKey', 'REG_SZ', 'codeswitchboard-local'],
    ['inferenceGatewayAuthScheme', 'REG_SZ', 'bearer'],
    // Keep discovery disabled: Claude Desktop filters auto-discovered IDs to
    // recognizable Claude names. The explicit inferenceModels value is the
    // supported way to expose arbitrary provider model IDs.
    ['modelDiscoveryEnabled', 'REG_DWORD', '0'],
    ['inferenceModels', 'REG_SZ', JSON.stringify(desktopModels)],
    [CLAUDE_POLICY_MARKER, 'REG_DWORD', '1']
  ];
}

function registryValueExists(name) {
  return spawnSync('reg.exe', ['query', CLAUDE_POLICY_KEY, '/v', name], { windowsHide: true, encoding: 'utf8' }).status === 0;
}

function registryValue(name) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('reg.exe', ['query', CLAUDE_POLICY_KEY, '/v', name], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.includes('REG_'));
  return line?.trim().split(/\s{2,}/).slice(2).join('  ') || null;
}

function installClaudeDesktopRouting(localRoot, models) {
  if (process.platform !== 'win32') return;
  const desiredModels = claudeDesktopPolicyEntries(localRoot, models).find(([name]) => name === 'inferenceModels')[2];
  const parsedModels = JSON.parse(desiredModels);
  console.log('[claude-app] writing registry with', parsedModels.length, 'models:', parsedModels.slice(0, 10).map((entry) => entry.labelOverride).join(', '), parsedModels.length > 10 ? '...' : '');
  const managedByUs = registryValueExists(CLAUDE_POLICY_MARKER);
  const existingModels = registryValue('inferenceModels');    if (managedByUs && registryValue('inferenceGatewayBaseUrl') === localRoot && registryValue('modelDiscoveryEnabled') === '0x0' && existingModels === desiredModels) { console.log('[claude-app] registry already up to date'); return; }
  if (managedByUs) console.log('[claude-app] updating registry (existing models differ or base URL changed)', { existingModelCount: existingModels ? JSON.parse(existingModels).length : 0 });
  if (!managedByUs && claudeDesktopPolicyEntries(localRoot).slice(0, -1).some(([name]) => registryValueExists(name))) {
    throw new Error('Claude Desktop already has an administrator-managed inference policy. CodeSwitchboard will not overwrite it.');
  }
  const installer = path.join(__dirname, '..', 'scripts', 'claude-desktop-policy.ps1');
  const modelsBase64 = Buffer.from(desiredModels, 'utf8').toString('base64');
  const argumentList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-BaseUrl', localRoot, '-ModelsBase64', modelsBase64]
    .map((value) => `'${String(value).replaceAll("'", "''")}'`).join(',');
  const command = `$process=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(${argumentList}); exit $process.ExitCode`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: false, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0 || !registryValueExists(CLAUDE_POLICY_MARKER)) {
    throw new Error('Claude Desktop gateway setup was not approved. Launch it again and accept the one-time Windows administrator prompt.');
  }
}

function restoreClaudeDesktopRouting() {
  if (process.platform !== 'win32') return;
  if (!registryValueExists(CLAUDE_POLICY_MARKER)) return;
  const installer = path.join(__dirname, '..', 'scripts', 'claude-desktop-policy.ps1');
  const argumentList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Restore']
    .map((value) => `'${String(value).replaceAll("'", "''")}'`).join(',');
  const command = `$process=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(${argumentList}); exit $process.ExitCode`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: false, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0 || registryValueExists(CLAUDE_POLICY_MARKER)) {
    throw new Error('Claude Desktop restore was not approved. Try again and accept the Windows administrator prompt.');
  }
}

function stopClaudeDesktop() {
  if (process.platform !== 'win32') return;
  const script = `$package=Get-AppxPackage -Name Claude; if (-not $package) { exit 2 }; $root=$package.InstallLocation; Get-CimInstance Win32_Process -Filter "Name = 'Claude.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }; Start-Sleep -Milliseconds 700`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error(`Could not restart Claude Desktop: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
}

function launchClaudeDesktop() {
  if (process.platform !== 'win32') throw new Error('Claude Desktop packaged-app activation is currently supported only on Windows.');
  const script = [
    "$package = Get-AppxPackage -Name Claude | Select-Object -First 1",
    "if (-not $package) { throw 'Claude Desktop package is not installed.' }",
    '$manifest = Get-AppxPackageManifest -Package $package.PackageFullName',
    '$application = $manifest.Package.Applications.Application | Select-Object -First 1',
    "if (-not $application.Id) { throw 'Claude Desktop has no registered application ID.' }",
    "$aumid = $package.PackageFamilyName + '!' + $application.Id",
    "Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\' + $aumid)",
    '$deadline = [DateTime]::UtcNow.AddSeconds(8)',
    'do {',
    '  Start-Sleep -Milliseconds 250',
    `  $running = Get-CimInstance Win32_Process -Filter "Name = 'Claude.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($package.InstallLocation, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1`,
    '} while (-not $running -and [DateTime]::UtcNow -lt $deadline)',
    "if (-not $running) { throw 'Windows activated Claude Desktop, but its process did not stay running.' }",
    'Write-Output $aumid'
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`Could not launch Claude Desktop: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return String(result.stdout || '').trim();
}

function detectedTargets() {
  return TARGETS.map((target) => ({
    ...target,
    installed: target.id === 'codex-desktop' ? codexDesktopInstalled()
      : target.id === 'claude-app' ? Boolean(claudeDesktopExecutable())
      : Boolean(resolveTargetExecutable(target))
  }));
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function launchTerminal(executable, args, options = {}) {
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `Set-Location -LiteralPath ${quotePowerShell(options.cwd)}`,
      `& ${quotePowerShell(executable)} ${args.map(quotePowerShell).join(' ')}`,
      "$code = $LASTEXITCODE",
      "if ($null -ne $code -and $code -ne 0) { Write-Host ''; Write-Host ('CodeSwitchboard: command exited with code ' + $code) -ForegroundColor Red }"
    ].join('; ');
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const startCommand = `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit','-NoProfile','-EncodedCommand','${encodedCommand}') -WorkingDirectory ${quotePowerShell(options.cwd)}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', startCommand], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Windows could not open the terminal.').trim());
    return;
  }
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: 'ignore' });
  child.unref();
}

function launchModelTerminal(executable, args, options = {}) {
  const invocation = unwrapNpmCommand(executable, args);
  const host = path.join(__dirname, '..', 'bin', 'codeswitchboard-model-terminal.js');
  launchTerminal(process.execPath, [host], {
    cwd: options.cwd,
    env: {
      ...options.env,
      CODESWITCHBOARD_CHILD_EXECUTABLE: invocation.executable,
      CODESWITCHBOARD_CHILD_ARGS: JSON.stringify(invocation.args),
      CODESWITCHBOARD_MODELS: JSON.stringify(options.models || []),
      CODESWITCHBOARD_MODEL_COMMAND: options.modelCommand || '/model {model}',
      CODESWITCHBOARD_MODEL_DISPLAY_PREFIX: options.displayPrefix || ''
    }
  });
}

function verifyCli(executable, env) {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `& ${quotePowerShell(executable)} --version`], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    : spawnSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Could not start ${executable}.`).trim());
  }
}

function launchEditor(executable, workspace) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath ${quotePowerShell(executable)} -ArgumentList ${quotePowerShell(workspace)}`], { windowsHide: true });
    if (result.status !== 0) throw new Error('Windows could not launch the editor.');
    return;
  }
  const child = spawn(executable, [workspace], { detached: true, stdio: 'ignore' });
  child.unref();
}

function createOpenCodeConfig(provider, model, envName, models = [model]) {
  const ids = [...new Set([...models, model].filter(Boolean))];
  return JSON.stringify({
    provider: {
      codeswitchboard: {
        npm: '@ai-sdk/openai-compatible',
        name: provider.name,
        options: { baseURL: provider.baseUrl, apiKey: `{env:${envName}}` },
        models: Object.fromEntries(ids.map((id) => [id, {
          name: id,
          limit: { context: 131072, output: 16384 },
          modalities: { input: ['text'], output: ['text'] }
        }]))
      }
    },
    model: `codeswitchboard/${model}`
  });
}

function createClaudeProxyEnv(baseEnv, localRoot, model) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !key.startsWith('ANTHROPIC_') && key !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'));
  return {
    ...env,
    ANTHROPIC_BASE_URL: localRoot,
    ANTHROPIC_AUTH_TOKEN: 'codeswitchboard-local',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '190000',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_PROXY: [baseEnv.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    no_proxy: [baseEnv.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  };
}

function localBypassEnv(baseEnv, localRoot) {
  return {
    ...baseEnv,
    NO_PROXY: [baseEnv.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    no_proxy: [baseEnv.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  };
}

function createHermesRouting(localBaseUrl, model) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-hermes-'));
  const configPath = path.join(directory, 'config.yaml');
  const quote = (value) => JSON.stringify(String(value));
  const config = [
    'model:',
    `  provider: ${quote('openai-api')}`,
    `  default: ${quote(model)}`,
    `  base_url: ${quote(localBaseUrl)}`,
    '  api_mode: chat_completions',
    'auxiliary:',
    '  title_generation:',
    `    provider: ${quote('openai-api')}`,
    `    model: ${quote(model)}`,
    `    base_url: ${quote(localBaseUrl)}`,
    `    api_key: ${quote('codeswitchboard-local')}`,
    '    timeout: 30',
    '    extra_body: {}',
    'privacy:',
    '  usage_statistics_enabled: false',
    ''
  ].join('\\n');
  fs.writeFileSync(configPath, config);
  return { directory, configPath };
}

function createHermesProxyEnv(baseEnv, localRoot, hermesHome) {
  const secretNames = new Set([
    'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
    'TOGETHER_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'HF_TOKEN',
    'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'KIMI_API_KEY', 'MINIMAX_API_KEY',
    'DASHSCOPE_API_KEY', 'GLM_API_KEY', 'KILOCODE_API_KEY', 'NOUS_API_KEY'
  ]);
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !secretNames.has(key)));
  return localBypassEnv({
    ...env,
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
    OPENAI_API_KEY: 'codeswitchboard-local',
    OPENAI_BASE_URL: localRoot,
    TERM: 'xterm-256color'
  }, localRoot);
}

function createGeminiProxyEnv(baseEnv, localRoot) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => ![
    'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
    'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_DEFAULT_AUTH_TYPE'
  ].includes(key)));
  return localBypassEnv({
    ...env,
    GEMINI_API_KEY: 'codeswitchboard-local',
    GOOGLE_GEMINI_BASE_URL: localRoot,
    GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key'
  }, localRoot);
}

// Verified against @cline/cli: the auth/config commands read and write
// `<configDir>/data/settings/providers.json`, and openai-native honors the
// settings fields { provider, apiKey, model, baseUrl }. The invented
// models.json and extra fields are ignored by the CLI, so keep the schema
// minimal and exactly what Cline itself writes.
function createClineRouting(localBaseUrl, model, models = [model]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-cline-'));
  const settings = path.join(directory, 'data', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  const providersPath = path.join(settings, 'providers.json');
  const provider = { provider: 'openai-native', apiKey: 'codeswitchboard-local', model, baseUrl: localBaseUrl };
  fs.writeFileSync(providersPath, JSON.stringify({
    version: 1, lastUsedProvider: 'openai-native', modes: {},
    providers: { 'openai-native': { settings: provider, updatedAt: new Date().toISOString(), tokenSource: 'manual' } }
  }, null, 2));
  return { directory, providersPath, configArgs: ['--config', directory, '--data-dir', path.join(directory, 'data')] };
}

function createDshRouting(localBaseUrl, model, models = [model]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-dsh-'));
  const patchPath = path.join(directory, 'codeswitchboard.patch.yml');
  const settingsPath = path.join(directory, 'settings.yaml');
  const credentialsPath = path.join(directory, '.credentials.yaml');
  fs.writeFileSync(settingsPath, '{}');
  fs.writeFileSync(credentialsPath, '{}');
  const patch = [
    { id: 'settings', name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } },
    { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentialsPath, watch: false } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { codeswitchboard: { displayName: 'CodeSwitchboard', apiKeyEnv: 'CODESWITCHBOARD_DSH_TOKEN', api: 'openai-responses', baseURL: localBaseUrl, models: [...new Set([...models, model])].map((id) => ({ id, name: id, reasoningEfforts: false })), defaultInput: ['text'], retryPolicy: { mode: 'normal', maxRetries: 0 }, streamIdleTimeoutMs: 240000 } } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'codeswitchboard', model } },
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek', disabled: true },
    { id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', disabled: true },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', disabled: true }
  ];
  fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
  return { directory, patchPath };
}

function createAiderRouting(model, models = [model]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-aider-'));
  const settingsPath = path.join(directory, 'model-settings.yml');
  const metadataPath = path.join(directory, 'model-metadata.json');
  const ids = [...new Set([...models, model])];
  const settings = ids.map((id) => ({ name: `openai/${id}`, edit_format: 'whole', use_repo_map: false }));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  fs.writeFileSync(metadataPath, JSON.stringify(Object.fromEntries(ids.map((id) => [`openai/${id}`, {
    mode: 'chat', litellm_provider: 'openai', max_input_tokens: 131072, max_output_tokens: 16384,
    input_cost_per_token: 0, output_cost_per_token: 0
  }])), null, 2));
  return { directory, settingsPath, metadataPath };
}

function providerModelId(providerId, model) {
  const value = String(model || '');
  const prefix = `${providerId}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function openCodeModelSelection(providerId, model, models = [model]) {
  const selected = providerModelId(providerId, model);
  const available = [...new Set([...models, model].filter(Boolean).map((id) => providerModelId(providerId, id)))];
  return {
    selected,
    selectedProviderModel: `${providerId}/${selected}`,
    providerModels: available.map((id) => `${providerId}/${id}`)
  };
}

function routedModelIds(providerId, model, models = [model]) {
  return [...new Set([...models, model].filter(Boolean))].map((id) => `${providerId}/${providerModelId(providerId, id)}`);
}

function createCrushRouting(localGatewayBaseUrl, providerId, model, models = [model]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-crush-'));
  const configDirectory = path.join(directory, 'crush');
  fs.mkdirSync(configDirectory);
  const configPath = path.join(configDirectory, 'crushrc');
  const ids = routedModelIds(providerId, model, models);
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const lines = [
    `provider add codeswitchboard --name 'CodeSwitchboard' --type openai-compat --base-url ${quote(localGatewayBaseUrl)} --api-key 'codeswitchboard-local' --discover-models false`,
    ...ids.map((id) => `model add ${quote(`codeswitchboard/${id}`)} --name ${quote(id)} --context-window 131072 --default-max-tokens 16384`),      `model large ${quote(`codeswitchboard/${providerId}/${providerModelId(providerId, model)}`)}`,
    `model small ${quote(`codeswitchboard/${providerId}/${providerModelId(providerId, model)}`)}`
  ];
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
  return { directory, configPath, selectedModel: `codeswitchboard/${providerId}/${providerModelId(providerId, model)}` };
}

function createQwenRouting(localGatewayBaseUrl, providerId, model, models = [model]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeswitchboard-qwen-'));
  // Qwen's modelProviders.openai entries already belong to the openai auth
  // type; prefixing their IDs with the CodeSwitchboard provider causes Qwen to
  // prefix them a second time in its native picker.
  const ids = [...new Set([...models, model].filter(Boolean).map((id) => providerModelId(providerId, id)))];
  const settings = {
    security: { auth: { selectedType: 'openai' } },
    model: { name: `${providerId}/${providerModelId(providerId, model)}` },
    modelProviders: {
      openai: ids.map((id) => ({ id, name: id, envKey: 'CODESWITCHBOARD_LOCAL_KEY', baseUrl: localGatewayBaseUrl, generationConfig: { contextWindowSize: 131072 } }))
    },
    privacy: { usageStatisticsEnabled: false }
  };
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings, null, 2));
  return { directory, selectedModel: providerModelId(providerId, model) };
}

function createKiloConfig(localGatewayBaseUrl, providerId, model, models = [model]) {
  const ids = routedModelIds(providerId, model, models);
  const selectedModel = `${providerId}/${providerModelId(providerId, model)}`;
  return JSON.stringify({
    $schema: 'https://app.kilo.ai/config.json',
    model: `codeswitchboard/${selectedModel}`,
    provider: {
      codeswitchboard: {
        name: 'CodeSwitchboard',
        npm: '@ai-sdk/openai-compatible',
        options: { apiKey: '{env:CODESWITCHBOARD_LOCAL_KEY}', baseURL: localGatewayBaseUrl },
        models: Object.fromEntries(ids.map((id) => [id, { name: id, tool_call: true, limit: { context: 131072, output: 16384 } }]))
      }
    },
    permission: { '*': 'ask' }
  });
}

function unwrapNpmCommand(executable, args) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(executable)) return { executable, args };
  try {
    const shim = fs.readFileSync(executable, 'utf8');
    const match = shim.match(/"%dp0%\\([^"]+)"\s+%\*\s*$/im);
    if (!match) return { executable, args };
    const target = path.resolve(path.dirname(executable), match[1]);
    if (!fs.existsSync(target)) return { executable, args };
    return /\.exe$/i.test(target)
      ? { executable: target, args }
      : { executable: process.execPath, args: [target, ...args] };
  } catch {
    return { executable, args };
  }
}

function runCaptured(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const invocation = unwrapNpmCommand(executable, args);
    const child = spawn(invocation.executable, invocation.args, { cwd: options.cwd, env: options.env, windowsHide: true });
    child.stdin.end();
    let stdout = '', stderr = '', matched = false, timedOut = false;
    const stopProcessTree = () => {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    };
    const inspect = () => {
      // Do not terminate a test-owned CLI when its output happens to contain
      // the marker. Some CLIs echo the prompt, and forcible task-tree kills
      // trigger shutdown assertions in otherwise successful Windows CLIs.
      matched = Boolean(options.successMarker && stdout.includes(options.successMarker));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree();
    }, options.timeout || 180000);
    child.stdout.on('data', (chunk) => { stdout += chunk; inspect(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; inspect(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, matched, timedOut });
    });
  });
}

class TargetLauncher {
  constructor({ legacyLauncherPath }) {
    this.legacyLauncherPath = legacyLauncherPath;
    this.bridges = new Map();
    this.verifiedExecutables = new Set();
    this.temporaryDirectories = new Set();
    this.claudeDesktopBridge = null;
  }

  keepTemporary(routing) {
    this.temporaryDirectories.add(routing.directory);
    return routing;
  }

  async bridgeFor(provider, apiKey, kind = 'responses', model = '', models = [model], { localToken = 'codeswitchboard-local' } = {}) {
    const bridgeKey = `${kind}:${provider.id}:${model}`;
    const existing = this.bridges.get(bridgeKey);
    if (existing && existing.apiKey === apiKey && existing.baseUrl === provider.baseUrl && existing.model === model) return existing;
    if (existing) existing.bridge.close();
    const starter = kind === 'anthropic' ? startAnthropicBridge : kind === 'gemini' ? startGeminiBridge : startBridge;
    const bridge = await starter({ port: 0, upstreamBaseUrl: provider.baseUrl, apiKey, providerName: provider.id, model, models, localToken });
    const managed = { bridge, apiKey, baseUrl: provider.baseUrl, model, requestCount: () => bridge.requestCount?.() || 0 };
    this.bridges.set(bridgeKey, managed);
    return managed;
  }

  async launch({ targetId, provider, apiKey, model, models = [model], workspace, localGatewayBaseUrl }) {
    const target = TARGETS.find((item) => item.id === targetId);
    if (!target) throw new Error('Unknown launch target.');
    const executable = target.id === 'codex-desktop' ? resolveCommand('codex')
      : target.id === 'claude-app' ? claudeDesktopExecutable()
      : resolveTargetExecutable(target);
    if (target.id === 'codex-desktop' && !codexDesktopInstalled()) throw new Error('Codex Desktop is not installed.');
    if (target.id === 'claude-app' && !executable) throw new Error('Claude Desktop is not installed.');
    if (target.id !== 'codex-desktop' && target.id !== 'claude-app' && !executable) throw new Error(`${target.name} is not installed or is not on PATH.`);
    if (!fs.existsSync(workspace)) throw new Error('Workspace path does not exist.');
    if (target.kind === 'cli' && target.routing !== 'native-account' && !this.verifiedExecutables.has(executable)) {
      verifyCli(executable, process.env);
      this.verifiedExecutables.add(executable);
    }

    if (target.id === 'codex-desktop') {
      const legacyProvider = ['nvidia', 'openrouter', 'groq', 'together'].includes(provider.id) ? provider.id : 'custom';
      if (process.platform === 'win32') {
        await launchOutsideCodexJob(process.execPath, [this.legacyLauncherPath, 'launch', 'codex-app'], {
          provider: legacyProvider,
          model,
          models,
          workspace,
          baseUrl: provider.baseUrl,
          apiKey,
          restartDashboard: true
        });
        return { message: `Codex Desktop is restarting the same task with ${model}.` };
      }
      const envName = legacyProvider === 'custom' ? 'CODEX_PROVIDER_API_KEY' : provider.env;
      const result = spawnSync(process.execPath, [this.legacyLauncherPath, 'launch', 'codex-app', '--provider', legacyProvider, '--model', model, '--workspace', workspace, ...(legacyProvider === 'custom' ? ['--base-url', provider.baseUrl] : [])], {
        env: { ...process.env, [envName]: apiKey }, encoding: 'utf8', windowsHide: true, timeout: 30000
      });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Codex Desktop launch failed.').trim());
      return { message: result.stdout.trim() || 'Codex Desktop launched.' };
    }

    if (target.id === 'codex-cli') {
      // Codex CLI with requires_openai_auth=false sends no Authorization
      // header, so its bridge must not require the local token. The bridge
      // stays loopback-only, matching the tokenless Codex Desktop daemon.
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models, { localToken: null });
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      // Codex CLI owns its interactive TUI and raw keyboard handling. It must
      // receive the real console input stream directly; the generic
      // model-terminal PTY makes its input unresponsive. The dashboard model
      // is applied on launch; change it in CodeSwitchboard and relaunch.
      launchTerminal(executable, [
        '-C', workspace,
        '-m', model,
        '-c', 'model_provider="codeswitchboard_bridge"',
        '-c', `model_providers.codeswitchboard_bridge.name=${JSON.stringify(`${provider.name} via CodeSwitchboard`)}`,
        '-c', `model_providers.codeswitchboard_bridge.base_url=${JSON.stringify(localBaseUrl)}`,
        '-c', 'model_providers.codeswitchboard_bridge.wire_api="responses"',
        '-c', 'model_providers.codeswitchboard_bridge.requires_openai_auth=false'
      ], { cwd: workspace, env: process.env });
      return { message: `Codex CLI launched with ${model}. Change the model in the dashboard and relaunch Codex.` };
    }

    if (target.id === 'aider-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = this.keepTemporary(createAiderRouting(model, models));
      // Aider owns its interactive readline input. The generic model-terminal
      // PTY makes typing unresponsive, so Aider receives the real console
      // directly. The dashboard model is applied on launch; change it in
      // CodeSwitchboard and relaunch.
      launchTerminal(executable, ['--model-settings-file', routing.settingsPath, '--model-metadata-file', routing.metadataPath, '--model', `openai/${model}`], {
        cwd: workspace,
        env: { ...process.env, OPENAI_API_BASE: localBaseUrl, OPENAI_API_KEY: 'codeswitchboard-local' }
      });
      return { message: `Aider launched with ${model}. Change the model in the dashboard and relaunch Aider.` };
    }

    if (target.id === 'opencode-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const keyEnv = 'CODESWITCHBOARD_LOCAL_KEY';
      launchTerminal(executable, ['--model', `codeswitchboard/${provider.id}/${providerModelId(provider.id, model)}`], {
        cwd: workspace,
        env: {
          ...process.env,
          [keyEnv]: 'codeswitchboard-local',
          OPENCODE_CONFIG_CONTENT: createOpenCodeConfig({ ...provider, baseUrl: localBaseUrl }, `${provider.id}/${providerModelId(provider.id, model)}`, keyEnv, models.map((id) => `${provider.id}/${providerModelId(provider.id, id)}`))
        }
      });
      return { message: `OpenCode launched with ${model}.` };
    }

    if (target.id === 'claude-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'anthropic', model, models);
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      // Claude Code owns its interactive TUI and raw keyboard handling. It
      // must receive the real console input stream directly; the generic
      // model-terminal PTY makes typing unresponsive. The dashboard model is
      // applied on launch; change it in CodeSwitchboard and relaunch.
      const env = createClaudeProxyEnv(process.env, localRoot, model);
      launchTerminal(executable, ['--permission-mode', 'default', '--model', model], { cwd: workspace, env });
      return { message: `Claude Code launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Claude.` };
    }

    if (target.id === 'claude-app') {
      console.log('[launch] claude-app starting dedicated bridge');
      if (this.claudeDesktopBridge) await new Promise((resolve) => this.claudeDesktopBridge.close(resolve));
      const managed = { bridge: await startAnthropicBridge({ port: CLAUDE_DESKTOP_BRIDGE_PORT, upstreamBaseUrl: provider.baseUrl, apiKey, providerName: provider.id, model, models }) };
      this.claudeDesktopBridge = managed.bridge;
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      console.log(`[launch] claude-app bridge ready at ${localRoot}`);
      installClaudeDesktopRouting(localRoot, [model, ...models]);
      console.log('[launch] claude-app policy ready');
      stopClaudeDesktop();
      console.log('[launch] claude-app previous instance stopped');
      const appUserModelId = launchClaudeDesktop();
      console.log(`[launch] claude-app activated as ${appUserModelId}`);
      return { message: `Claude Desktop restarted in gateway mode through ${provider.name}. Select ${model} in its model picker.` };
    }

    if (target.id === 'pi-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'anthropic', model, models);
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      const extension = path.join(__dirname, 'pi-codeswitchboard-extension.ts');
      const env = localBypassEnv(process.env, localRoot);
      Object.assign(env, { CODESWITCHBOARD_PI_BASE_URL: localRoot, CODESWITCHBOARD_PI_TOKEN: 'codeswitchboard-local', CODESWITCHBOARD_PI_MODEL: model, CODESWITCHBOARD_PI_MODELS: JSON.stringify(models) });
      launchTerminal(executable, ['-e', extension, '--provider', 'codeswitchboard', '--model', model, '--models', `codeswitchboard/${model}`], { cwd: workspace, env });
      return { message: `Pi launched through ${provider.name} with ${model}.` };
    }

    if (target.id === 'cline-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = this.keepTemporary(createClineRouting(localBaseUrl, model, models));
      const env = localBypassEnv(process.env, localBaseUrl);
      delete env.CLINE_PROVIDER_SETTINGS_PATH;
      // Cline owns its interactive TUI and must receive the real console
      // input stream directly. Wrapping it in the generic model-terminal PTY
      // makes Cline's readline/raw-mode handling lose keystrokes. Model
      // changes for this launch are applied from the dashboard, then Cline is
      // relaunched with the new selection.
      launchTerminal(executable, [...routing.configArgs, '--provider', 'openai-native', '--model', model, '--tui'], { cwd: workspace, env });
      return { message: `Cline launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Cline.` };
    }

    if (target.id === 'dsh-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = this.keepTemporary(createDshRouting(localBaseUrl, model, models));
      const env = localBypassEnv(process.env, localBaseUrl);
      env.CODESWITCHBOARD_DSH_TOKEN = 'codeswitchboard-local';
      launchTerminal(executable, ['web', '--patch', routing.patchPath], { cwd: workspace, env });
      return { message: `DeepSeek Harness Web launched through ${provider.name} with ${model}.` };
    }

    if (target.id === 'hermes-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      // Ignore only Hermes' provider config for this process. This prevents
      // auxiliary auto-routing from selecting an unrelated account while
      // preserving the real HERMES_HOME, sessions, skills, and conversations.
      launchTerminal(executable, ['chat', '--cli', '--ignore-user-config', '--provider', 'openai-api', '--model', model, '--in', workspace], {
        cwd: workspace,
        env: createHermesProxyEnv(process.env, localBaseUrl, process.env.HERMES_HOME)
      });
      return { message: `Hermes Agent launched through ${provider.name} with ${model}.` };
    }

    if (target.id === 'gemini-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'gemini', model, models);
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      // Gemini CLI owns its interactive terminal and raw input handling. Do
      // not place it inside the generic model-terminal PTY, which can consume
      // or transform keystrokes. The dashboard model is applied on launch;
      // change it in CodeSwitchboard and relaunch Gemini.
      launchTerminal(executable, ['--model', model], { cwd: workspace, env: createGeminiProxyEnv(process.env, localRoot) });
      return { message: `Gemini CLI launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Gemini.` };
    }

    if (target.id === 'crush-cli') {
      // The shared editor gateway only routes provider-prefixed model ids,
      // while these CLIs send bare vendor ids (Qwen) or re-prefixed ids
      // (Crush, Kilo). Give each launch its own Responses bridge that already
      // knows this provider, mirroring the non-interactive test adapters.
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = this.keepTemporary(createCrushRouting(localBaseUrl, provider.id, model, models));
      // Crush, Qwen, and Kilo own their interactive TUIs and raw keyboard
      // handling. They must receive the real console input stream directly;
      // the generic model-terminal PTY injects Windows mouse/capability
      // sequences into their prompts. The dashboard model is applied on
      // launch; change it in CodeSwitchboard and relaunch.
      launchTerminal(executable, [], {
        cwd: workspace,
        env: localBypassEnv({ ...process.env, XDG_CONFIG_HOME: routing.directory, CRUSH_GLOBAL_DATA: path.join(routing.directory, 'data'), CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: '1', CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local', DO_NOT_TRACK: '1' }, localBaseUrl)
      });
      return { message: `Crush launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Crush.` };
    }

    if (target.id === 'qwen-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = this.keepTemporary(createQwenRouting(localBaseUrl, provider.id, model, models));
      launchTerminal(executable, ['--bare', '--auth-type', 'openai', '--model', routing.selectedModel], {
        cwd: workspace,
        env: localBypassEnv({ ...process.env, QWEN_HOME: routing.directory, QWEN_RUNTIME_DIR: path.join(routing.directory, 'runtime'), CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local', OPENAI_API_KEY: 'codeswitchboard-local', OPENAI_BASE_URL: localBaseUrl }, localBaseUrl)
      });
      return { message: `Qwen Code launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Qwen.` };
    }

    if (target.id === 'kilo-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const selected = `${provider.id}/${providerModelId(provider.id, model)}`;
      launchTerminal(executable, ['--model', `codeswitchboard/${selected}`], {
        cwd: workspace,
        env: localBypassEnv({ ...process.env, KILO_CONFIG_CONTENT: createKiloConfig(localBaseUrl, provider.id, model, models), KILO_DISABLE_PROJECT_CONFIG: '1', CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local' }, localBaseUrl)
      });
      return { message: `Kilo Code launched through ${provider.name} with ${model}. Change the model in the dashboard and relaunch Kilo.` };
    }

    if (target.routing === 'native-account') {
      if (target.kind === 'cli') {
        launchTerminal(executable, [], { cwd: workspace, env: process.env });
      } else {
        launchEditor(executable, workspace);
      }
      return { message: `${target.name} opened with its native account configuration. Sign in there and use its native model picker.` };
    }

    if (target.routing === 'native') {
      launchTerminal(executable, [], { cwd: workspace, env: process.env });
      return { message: `${target.name} launched with its native account configuration.` };
    }

    launchEditor(executable, workspace);
    return { message: `${target.name} opened ${workspace}.` };
  }

  restoreClaudeDesktop() {
    if (this.claudeDesktopBridge) this.claudeDesktopBridge.close();
    this.claudeDesktopBridge = null;
    restoreClaudeDesktopRouting();
    stopClaudeDesktop();
    const appUserModelId = launchClaudeDesktop();
    return { message: `Claude Desktop restored to its normal account configuration and reopened (${appUserModelId}).` };
  }

  async testMessage({ targetId, provider, apiKey, model, models = [model], workspace, prompt, localGatewayBaseUrl }) {
    const target = TARGETS.find((item) => item.id === targetId);
    if (!target || target.id.startsWith('codex-')) throw new Error('This target is not available for message testing.');
    if (!['opencode-cli', 'aider-cli', 'claude-cli', 'pi-cli', 'cline-cli', 'dsh-cli', 'hermes-cli', 'gemini-cli', 'crush-cli', 'qwen-cli', 'kilo-cli'].includes(targetId)) throw new Error(`${target?.name || 'Target'} does not yet have a verified non-interactive message adapter.`);
    const executable = resolveTargetExecutable(target);
    if (!executable) throw new Error(`${target.name} is not installed.`);
    let args, env = { ...process.env }, cleanup;
    let testGatewayBaseUrl = localGatewayBaseUrl;
    if (['crush-cli', 'qwen-cli', 'kilo-cli'].includes(targetId)) {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      testGatewayBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
    }

    if (targetId === 'opencode-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const keyEnv = 'CODESWITCHBOARD_LOCAL_KEY';
      const selection = openCodeModelSelection(provider.id, model, models);
      Object.assign(env, { [keyEnv]: 'codeswitchboard-local', OPENCODE_CONFIG_CONTENT: createOpenCodeConfig({ ...provider, baseUrl: localBaseUrl }, selection.selectedProviderModel, keyEnv, selection.providerModels) });
      args = ['run', '--model', `codeswitchboard/${selection.selectedProviderModel}`, prompt];
    } else if (targetId === 'aider-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = createAiderRouting(model, models);
      cleanup = routing.directory;
      Object.assign(env, { OPENAI_API_BASE: localBaseUrl, OPENAI_API_KEY: 'codeswitchboard-local' });
      args = ['--no-git', '--yes-always', '--no-stream', '--model-settings-file', routing.settingsPath, '--model-metadata-file', routing.metadataPath, '--model', `openai/${model}`, '--message', prompt];
    } else if (targetId === 'claude-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'anthropic', model, models);
      env = createClaudeProxyEnv(process.env, `http://127.0.0.1:${managed.bridge.port}`, model);
      args = ['--print', '--output-format', 'text', '--permission-mode', 'default', '--model', model, prompt];
    } else if (targetId === 'pi-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'anthropic', model, models);
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      env = localBypassEnv(process.env, localRoot);
      Object.assign(env, { CODESWITCHBOARD_PI_BASE_URL: localRoot, CODESWITCHBOARD_PI_TOKEN: 'codeswitchboard-local', CODESWITCHBOARD_PI_MODEL: model, CODESWITCHBOARD_PI_MODELS: JSON.stringify(models) });
      args = ['-e', path.join(__dirname, 'pi-codeswitchboard-extension.ts'), '--provider', 'codeswitchboard', '--model', model, '--print', '--no-session', '--no-tools', prompt];
    } else if (targetId === 'cline-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = createClineRouting(localBaseUrl, model, models);
      cleanup = routing.directory;
      env = localBypassEnv(process.env, localBaseUrl);
      delete env.CLINE_PROVIDER_SETTINGS_PATH;
      args = [...routing.configArgs, '--provider', 'openai-native', '--model', model, '--json', '--auto-approve', 'false', '--timeout', '120', prompt];
    } else if (targetId === 'dsh-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = createDshRouting(localBaseUrl, model, models);
      cleanup = routing.directory;
      env = localBypassEnv(process.env, localBaseUrl);
      env.CODESWITCHBOARD_DSH_TOKEN = 'codeswitchboard-local';
      args = ['--profile', 'headless', '--patch', routing.patchPath, prompt];
    } else if (targetId === 'hermes-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'responses', model, models);
      const localBaseUrl = `http://127.0.0.1:${managed.bridge.port}/v1`;
      const routing = createHermesRouting(localBaseUrl, model);
      cleanup = routing.directory;
      env = createHermesProxyEnv(process.env, localBaseUrl, routing.directory);
      args = ['chat', '--cli', '--provider', 'openai-api', '--model', model, '--quiet', '--oneshot', '--safe-mode', '--max-turns', '1', '--query', prompt];
    } else if (targetId === 'gemini-cli') {
      const managed = await this.bridgeFor(provider, apiKey, 'gemini', model, models);
      const localRoot = `http://127.0.0.1:${managed.bridge.port}`;
      env = createGeminiProxyEnv(process.env, localRoot);
      args = ['--model', model, '--prompt', prompt, '--output-format', 'text', '--approval-mode', 'plan', '--skip-trust'];
    } else if (targetId === 'crush-cli') {
      const routing = createCrushRouting(testGatewayBaseUrl, provider.id, model, models);
      cleanup = routing.directory;
      env = localBypassEnv({ ...process.env, XDG_CONFIG_HOME: routing.directory, CRUSH_GLOBAL_DATA: path.join(routing.directory, 'data'), CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: '1', CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local', DO_NOT_TRACK: '1' }, testGatewayBaseUrl);
      args = ['run', prompt];
    } else if (targetId === 'qwen-cli') {
      const routing = createQwenRouting(testGatewayBaseUrl, provider.id, model, models);
      cleanup = routing.directory;
      env = localBypassEnv({ ...process.env, QWEN_HOME: routing.directory, QWEN_RUNTIME_DIR: path.join(routing.directory, 'runtime'), CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local', OPENAI_API_KEY: 'codeswitchboard-local', OPENAI_BASE_URL: testGatewayBaseUrl }, testGatewayBaseUrl);
      args = ['--bare', '--auth-type', 'openai', '--model', routing.selectedModel, '--output-format', 'text', '--approval-mode', 'plan', '--max-session-turns', '1', prompt];
    } else {
      env = localBypassEnv({ ...process.env, KILO_CONFIG_CONTENT: createKiloConfig(testGatewayBaseUrl, provider.id, model, models), KILO_DISABLE_PROJECT_CONFIG: '1', CODESWITCHBOARD_LOCAL_KEY: 'codeswitchboard-local' }, testGatewayBaseUrl);
      args = ['run', '--model', `codeswitchboard/${provider.id}/${providerModelId(provider.id, model)}`, prompt];
    }

    const requestCountBefore = this.bridges.size ? [...this.bridges.values()].reduce((total, entry) => total + entry.requestCount(), 0) : 0;
    let result;
    try {
      result = await runCaptured(executable, args, { cwd: workspace, env, timeout: 60000, successMarker: 'CODESWITCHBOARD_OK' });
    } finally {
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    }
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.timedOut) throw new Error(`${target.name} did not finish its test within 60 seconds: ${combined.slice(-1200)}`);
    if (result.status !== 0) throw new Error(`${target.name} test exited with code ${result.status}: ${combined.slice(-1200)}`);
    if (!result.matched) throw new Error(`${target.name} returned no assistant marker on stdout: ${combined.slice(-1200)}`);
    const requestCountAfter = this.bridges.size ? [...this.bridges.values()].reduce((total, entry) => total + entry.requestCount(), 0) : 0;
    if (requestCountAfter <= requestCountBefore) throw new Error(`${target.name} printed the marker but did not produce an inference request through the CodeSwitchboard bridge.`);
    return { targetId, target: target.name, output: result.stdout.slice(-4000), routed: true, inferenceRequests: requestCountAfter - requestCountBefore };
  }

  close() {
    for (const managed of this.bridges.values()) managed.bridge.close();
    this.bridges.clear();
    for (const directory of this.temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
    this.temporaryDirectories.clear();
    if (this.claudeDesktopBridge) this.claudeDesktopBridge.close();
    this.claudeDesktopBridge = null;
  }
}

module.exports = { TARGETS, detectedTargets, TargetLauncher, createOpenCodeConfig, openCodeModelSelection, createClaudeProxyEnv, createHermesRouting, createHermesProxyEnv, createGeminiProxyEnv, createAiderRouting, createClineRouting, createDshRouting, createCrushRouting, createQwenRouting, createKiloConfig, claudeDesktopPolicyEntries, resolveTargetExecutable, verifyCli };
