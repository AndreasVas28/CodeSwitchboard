# CodeSwitchboard

## PowerShell command

Use `csb` from any directory:

```powershell
csb open
csb stop
csb key set nvidia
csb select provider nvidia
csb select model poolside/laguna-xs-2.1
csb select target claude-app
csb launch
csb info
```

You can also launch in one command:

```powershell
csb launch claude-app --provider nvidia --model poolside/laguna-xs-2.1 --workspace C:\path\to\project
```

Run `csb providers`, `csb models nvidia`, and `csb targets` to discover IDs. Use `csb restore claude` or `csb restore codex` to return an app to its normal account. Provider keys are encrypted with Windows DPAPI for the current Windows user and saved with selections under `%LOCALAPPDATA%\CodeSwitchboard\config.json`; plaintext keys are never written to that file.

CodeSwitchboard is a local control panel for launching coding apps and terminal agents with the right model provider, account mode, and workspace.

It runs only on `127.0.0.1`. API keys pasted into the dashboard are encrypted with Windows DPAPI for the current user before being persisted; plaintext keys are held only in the server process, are never returned by the API, and are not passed to routed child tools.

## Start the dashboard

```powershell
npm install
npm link
codeswitchboard-server
```

The command opens [http://127.0.0.1:4242](http://127.0.0.1:4242). You can use another port or prevent the browser from opening:

```powershell
codeswitchboard-server --port 5050 --no-open
```

Then:

1. Choose NVIDIA NIM, OpenRouter, Groq, Together AI, Fireworks, DeepInfra, Cerebras, SambaNova, or a custom OpenAI-compatible endpoint.
2. Paste a session API key and load the live model catalog.
3. Choose a workspace and an installed app or CLI.
4. Launch it.

Provider environment variables are also supported. For example:

```powershell
$env:NVIDIA_API_KEY = "nvapi-your-key"
codeswitchboard-server
```

## Launch targets

| Target | Mode | What CodeSwitchboard does |
| --- | --- | --- |
| Codex Desktop | Provider routed | Starts the local Responses bridge and opens the real installed Codex app. |
| Codex CLI | Provider routed | Opens a terminal with a temporary Codex provider configuration. |
| OpenCode | Provider routed | Supplies a per-launch OpenAI-compatible provider configuration. |
| Aider | Provider routed | Supplies the endpoint, key, selected model, and full provider model catalog. |
| Claude Code | Provider routed | Runs an Anthropic-compatible local Messages bridge, selects the dashboard model, and opens Claude without requiring Anthropic login. |
| Claude Desktop | Provider routed | Starts the local Messages bridge on port 4243, applies Claude Desktop's managed gateway configuration after a one-time Windows administrator prompt, and exposes a Claude-compatible picker alias that routes to the NVIDIA model selected in CodeSwitchboard. |
| Pi | Provider routed | Loads an ephemeral provider extension through the local Messages bridge. |
| Cline CLI | Provider routed | Uses isolated per-launch provider and model files through the local Responses bridge. |
| DeepSeek Harness Web | Provider routed | Starts with a temporary CodeSwitchboard profile through the local Responses bridge. |
| Hermes Agent | Provider routed | Runs its OpenAI API mode through the local Responses bridge. |
| Gemini CLI | Provider routed | Runs a local Gemini-protocol bridge and supplies only a dummy loopback key to Gemini CLI. |
| Void | Provider routed | Opens the workspace for its OpenAI-compatible picker; its first launch needs the local gateway entered once. |
| VS Code | Workspace only | Opens the workspace; installed AI extensions keep control of their own authentication. |

Claude sessions receive only a loopback bridge URL and a dummy local bridge token. The selected provider key remains in the CodeSwitchboard server process and is never passed to Claude Code.

Cursor and Windsurf are intentionally not offered because their built-in agents require vendor accounts. Void provides an OpenAI-compatible, account-free editor path.

## Change models after launch

CodeSwitchboard passes the selected provider's complete model catalog into each supported routed tool. Every routed CLI now accepts the same command:

```text
/models
```

For CLIs without a native `/models` picker, CodeSwitchboard's terminal layer opens a searchable selector and translates the choice to the tool's native switch command without modifying the installed vendor package.

| Tool | Model command or picker |
| --- | --- |
| OpenCode | Native `/models` picker |
| Aider, Claude Code, Codex CLI, Cline, Gemini CLI | CodeSwitchboard `/models` searchable picker |
| Claude Desktop | App model picker (routes to the launched model) |
| Pi | CodeSwitchboard extension `/models` picker |
| Hermes Agent | Native `/model` command in classic CLI mode |
| DeepSeek Harness Web | Native `/models` picker |
| Void | Chat model picker |

The local editor gateway is `http://127.0.0.1:4242/v1`. It lists models as `provider-id/model-id`, routes them to the matching connected provider, and accepts only the loopback credential `codeswitchboard-local`. Real provider keys remain in server memory.

Targets live in `lib/target-registry.js`, so more apps and CLIs can be added without changing the dashboard. The catalog intentionally excludes unsupported or account-specific candidates that are not part of the current CodeSwitchboard product surface.

## Restore normal Codex account mode

Use **Restore Codex account mode** in the dashboard, or keep using the backwards-compatible command:

```powershell
free-codex launch codex-app --restore
```

This stops the managed bridge, restores the original Codex configuration, changes the most recently routed task back to the built-in OpenAI provider, and reopens it with the saved real account. Existing backups remain under `~/.codex/free-codex-backups` for compatibility with earlier versions.

## Legacy command

The original command remains available, so existing scripts continue working:

```powershell
free-codex launch codex-app --provider nvidia --model provider/model-id
```

For NVIDIA, `--model` remains optional and the live model catalog is added to the Codex model menu.

## Requirements

- Node.js 20 or newer
- At least one supported coding app or CLI installed and available on `PATH`
- A provider whose `/v1/models` and streaming `/v1/chat/completions` behavior is OpenAI-compatible for full routed-agent behavior

Run the tests with:

```powershell
npm test
```

To send a deterministic message through every installed, non-Codex routed CLI against a local mock provider:

```powershell
node scripts\verify-target-messages.js
```

The dashboard also shows **Send test message** for each routed non-Codex CLI. That test uses the selected live provider and confirms the tool returned `CODESWITCHBOARD_OK`.
