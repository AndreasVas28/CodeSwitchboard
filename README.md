# CodeSwitchboard

A local launcher for AI coding apps and CLIs on Windows, macOS, and Linux.
Choose a provider, model, and workspace in your browser or with the `csb` CLI,
then launch an installed tool. This is an independent experimental project.
Compatibility depends on the target, provider, model capabilities, and installed
versions; see [target status](docs/TARGET_STATUS.md).

## Install (one line)

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.ps1 | iex
```

macOS or Linux terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.sh | bash
```

The installer installs Git and Node.js 20+ if they are missing (via `winget` on
Windows, `brew`/`apt`/`dnf`/`pacman` on macOS and Linux), clones or updates the
repository to `~/CodeSwitchboard`, runs `npm ci`, and links the `csb` command.

Review before running if you prefer:

```powershell
irm https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.ps1 -OutFile install.ps1; notepad install.ps1
```

If `csb` is not found after installing, open a new terminal. To verify it:

```powershell
csb info
```

## Install from GitHub (manual)

Install Node.js 20 or newer and Git, then run:

```powershell
git clone https://github.com/AndreasVas28/CodeSwitchboard.git
cd CodeSwitchboard
npm ci
npm link
csb open
```

If `csb` is not found, reopen your terminal or run `node bin/csb.js open` from
this directory. If native dependency installation requires compilation, install
the C++ build tools and Python requested by node-gyp. Target applications
are installed separately. Use `csb catalog`, `csb target info <id>`, and
`csb install <id>` to inspect and install supported packages.

This repository distributes source code; it has no signed installer
or published npm package. Provider usage may require credits or a paid API plan.

## Command line

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

Run `csb providers`, `csb models nvidia`, and `csb targets` to discover IDs. Use `csb restore claude` or `csb restore codex` to return an app to its normal account. Keys and selections are stored locally: on Windows they are encrypted with DPAPI for the current user; on macOS and Linux the store file is protected with owner-only file permissions.

Settings live at `%LOCALAPPDATA%\CodeSwitchboard\config.json` on Windows and `~/.local/state/codeswitchboard/config.json` on macOS and Linux.

CodeSwitchboard is a local control panel for launching coding apps and terminal agents with the right model provider, account mode, and workspace.

It runs only on `127.0.0.1`. API keys pasted into the dashboard are encrypted with Windows DPAPI on Windows (or saved with owner-only file permissions on macOS and Linux) before being persisted; plaintext keys are held only in the server process, are never returned by the API, and are not passed to routed child tools.

## Providers

The dashboard and `csb providers` include NVIDIA NIM, OpenRouter, Groq,
Together AI, Fireworks AI, DeepInfra, Cerebras, SambaNova, and these presets:

| Provider | CLI ID | Environment variable | Official API documentation |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | [API](https://api-docs.deepseek.com/) |
| Mistral AI | `mistral` | `MISTRAL_API_KEY` | [API](https://docs.mistral.ai/api) |
| xAI (Grok) | `xai` | `XAI_API_KEY` | [API](https://docs.x.ai/overview) |
| Moonshot AI (Kimi, international) | `moonshot` | `MOONSHOT_API_KEY` | [Compatibility](https://platform.moonshot.ai/docs/guide/migrating-from-openai-to-kimi) |
| SiliconFlow (international) | `siliconflow` | `SILICONFLOW_API_KEY` | [API](https://docs.siliconflow.com/en/api-reference/models/get-model-list) |

Save the matching provider's API key in the dashboard or with `csb key set mistral`,
then use `csb models mistral` to load its current catalog. Select a returned model
with `csb select model <model-id>` and save the provider with `csb select provider mistral`.
Keys and selections use the same persistent storage as existing providers.
Use Custom endpoint for regional accounts or another OpenAI-compatible service.

These presets use live model discovery and the existing chat-completions gateway.
An available model is not necessarily suitable for a coding agent: choose a chat
model with tool support. Automated tests use local fixtures; live inference still
requires a valid provider key and a compatible model. Restart the dashboard after
updating to load new presets.

## Start the dashboard

```powershell
csb open
```

That starts the server and opens [http://127.0.0.1:4242](http://127.0.0.1:4242). You can run the server in the foreground, use another port, or prevent the browser from opening:

```powershell
csb server --port 5050 --no-open
```

Then:

1. Choose NVIDIA NIM, OpenRouter, Groq, Together AI, Fireworks, DeepInfra, Cerebras, SambaNova, or a custom OpenAI-compatible endpoint.
2. Enter a provider API key and load the live model catalog. Keys and selections are saved locally.
3. Choose a workspace and an installed app or CLI.
4. Launch it.

Provider environment variables are also supported:

```powershell
$env:NVIDIA_API_KEY = "nvapi-your-key"
csb server
```

```bash
export NVIDIA_API_KEY="nvapi-your-key"
csb server
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
| VS Code | Workspace only | Opens the workspace; installed AI extensions keep control of their own authentication. |
| Crush, Qwen Code, Kilo Code CLI | Provider routed | Supplies isolated OpenAI-compatible configuration and the selected model. |
| GitHub Copilot CLI | Native account | Opens the CLI with its own vendor account and model picker. |

Claude sessions receive only a loopback bridge URL and a dummy local bridge token. The selected provider key remains in the CodeSwitchboard server process and is never passed to Claude Code.

Cursor Agent CLI, Cursor, Windsurf, Kiro CLI, Kiro IDE, and Void are excluded from the active catalog.

## Change models after launch

Choose the model in the dashboard before launching. In-session switching depends
on the tool; a universal `/models` command is not available in every CLI.

| Tool | Model command or picker |
| --- | --- |
| OpenCode | Native `/models` picker |
| Aider | Native `/model openai/<name>` command; the routed catalog is printed at launch |
| Claude Code, Codex CLI, Gemini CLI, Crush, Qwen Code, Kilo CLI | Change the dashboard selection and relaunch |
| Cline | Chosen at launch or with `cline auth`; Cline 3.0.61's interactive `/model` picker crashes (upstream Cline bug) |
| Claude Desktop | App model picker (routes to the launched model) |
| Pi | CodeSwitchboard extension `/models` picker |
| Hermes Agent | Native `/model` command in classic CLI mode |
| DeepSeek Harness Web | Native `/models` picker |

The local editor gateway is `http://127.0.0.1:4242/v1`. It lists models as `provider-id/model-id`, routes them to the matching connected provider, and accepts only the loopback credential `codeswitchboard-local`. Real provider keys remain in server memory.

Targets live in `lib/target-registry.js`, so more apps and CLIs can be added without changing the dashboard. The catalog intentionally excludes unsupported or account-specific candidates that are not part of the current CodeSwitchboard product surface.

## Restore normal Codex account mode

Use **Restore Codex account mode** in the dashboard, or run:

```powershell
csb restore codex
```

This stops the managed bridge, restores the original Codex configuration, changes the most recently routed task back to the built-in OpenAI provider, and reopens it with the saved real account. Existing backups remain under `~/.codex/free-codex-backups` for compatibility with earlier versions.

## Uninstall

From any terminal, inside or outside the repository:

```powershell
csb uninstall
```

This restores Codex and Claude Desktop to their normal accounts, stops the
dashboard and its bridges, and removes the global `csb` command. Saved settings
are kept unless you add `--purge`, and app restores can be skipped with
`--keep-apps`. Use `--yes` to skip the confirmation prompt:

```powershell
csb uninstall --purge --yes
```

Standalone uninstallers are also included in the repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-Purge] [-KeepApps]
```

```bash
bash uninstall.sh [--purge] [--keep-apps]
```

After uninstalling, the repository folder can simply be deleted.

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

## Troubleshooting and restore

- Run `csb info` and `csb doctor <target-id>` for configuration and installation diagnostics.
- If a model is retired or unavailable, run `csb models <provider>` and choose a current model.
- If a tool requests vendor login, check its mode: native-account tools require that login. For routed tools, confirm that the launch came from CodeSwitchboard.
- For localhost connection failures, check that CodeSwitchboard is running and relaunch the target. Keep the full redacted error, including its HTTP status.
- Restore desktop account settings with `csb restore claude` or `csb restore codex` before removing CodeSwitchboard. These commands may restart the relevant app.
- `csb stop` stops the dashboard and its managed bridges. The separately launched Codex Desktop bridge has its own restore command.

Settings are stored at `%LOCALAPPDATA%\CodeSwitchboard\config.json` (Windows) or `~/.local/state/codeswitchboard/config.json` (macOS and Linux). Use
`csb key remove <provider>` to remove a saved key, or `csb uninstall --purge` to remove all saved state. To update a clean checkout,
run `git pull --ff-only` and `npm ci`, then restart the dashboard.

## Development and licensing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[CHANGELOG.md](CHANGELOG.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Original CodeSwitchboard code is licensed under [MIT](LICENSE). Third-party
applications and services retain their own licenses and terms.
