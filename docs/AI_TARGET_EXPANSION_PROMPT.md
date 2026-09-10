# CodeSwitchboard target-expansion implementation prompt

Copy the prompt below into a capable coding agent working at the root of the CodeSwitchboard repository.

---

You are extending **CodeSwitchboard**, a Windows-first local control panel and PowerShell CLI that launches AI coding applications and terminal agents using provider API keys selected by the user. Work directly in the existing repository. Do not replace the application with a prototype and do not remove working behavior.

## Objective

Turn CodeSwitchboard into a comprehensive, maintainable launcher for actively maintained AI coding apps and CLIs. A target is not complete merely because its process opens. Provider-routed targets must accept the selected CodeSwitchboard provider and model, avoid an unrelated vendor-login prompt, perform a real inference request, expose model switching where the target supports it, survive a CodeSwitchboard restart, and have a safe restore path.

The product must remain honest. Some tools require their own vendor account and cannot use an arbitrary OpenAI-compatible or Anthropic-compatible endpoint. Install and launch those only in **native-account** mode and clearly label them. Never claim that a vendor-account target is routed through NVIDIA or another CodeSwitchboard provider.

## Existing behavior to preserve

Before editing, inspect `package.json`, `README.md`, `lib/target-registry.js`, `lib/control-server.js`, `bin/csb.js`, the bridge implementations, the web UI, and all tests. Preserve:

- `csb server`, `csb open`, `csb stop`, `csb info`, `csb providers`, `csb models`, `csb targets`, `csb key`, `csb select`, `csb launch`, and `csb restore`.
- The dashboard on loopback only.
- Provider and target selections persisted across restarts.
- Provider keys encrypted for the current Windows user with DPAPI. Never store plaintext provider keys in JSON, logs, command history, generated config files, or child-process arguments.
- OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini compatibility bridges.
- The full provider model catalog and existing model selectors.
- Existing Codex and Claude restore behavior.
- Current targets: Codex Desktop, Codex CLI, OpenCode, Aider, Claude Code, Claude Desktop, Pi, Cline CLI, DeepSeek Harness Web, Hermes Agent, Gemini CLI, VS Code, and Void.
- The rule that live message tests exclude Codex unless the user explicitly authorizes testing it.

## Scope and target taxonomy

Do not interpret “all” as every abandoned AI repository ever published. Build a catalog that is broad and updateable, covering actively maintained coding agents with an official website, documentation, repository, or package. Every catalog entry must use one of these modes:

1. **provider-routed** — an official custom endpoint, OpenAI-compatible, Anthropic-compatible, Gemini-compatible, or supported BYOK configuration exists.
2. **native-account** — the tool is useful but officially requires its own account, subscription, or service API key.
3. **workspace-only** — CodeSwitchboard can open the editor/workspace but cannot configure its AI agent.
4. **extension** — installed into an editor profile; routing and verification belong to the extension, not the editor executable.
5. **WSL/container** — not a dependable native-Windows target; launch only after an explicit compatibility and prerequisite check.
6. **unsupported** — abandoned, unverifiable, unsafe to automate, or incompatible. Keep the research result but do not show it as installable.

## Seed catalog

Use this as the initial catalog, then verify every entry against current official documentation before implementing it. Add newly discovered active tools when they meet the same evidence standard.

### Already implemented — regression test, do not duplicate

| Target | Surface | Expected mode |
| --- | --- | --- |
| Codex | Desktop + CLI | provider-routed, with restore |
| Claude | Desktop + Claude Code CLI | provider-routed, with restore |
| Gemini CLI | CLI | provider-routed through Gemini bridge |
| OpenCode | CLI | provider-routed |
| Aider | CLI | provider-routed |
| Pi Coding Agent | CLI | provider-routed |
| Cline | CLI | provider-routed |
| DeepSeek Harness | Web/CLI | provider-routed |
| Hermes Agent | CLI | provider-routed |
| Void | Desktop editor | provider-routed after supported setup |
| VS Code | Desktop editor | workspace-only; extensions are separate targets |

### Highest-priority additions — prove these first

| Target | Surface | Initial classification | Official starting point |
| --- | --- | --- | --- |
| Crush | CLI | provider-routed | https://github.com/charmbracelet/crush |
| Qwen Code | CLI | provider-routed | https://github.com/QwenLM/qwen-code |
| Kilo Code | CLI | provider-routed | https://github.com/Kilo-Org/kilocode |
| goose | CLI + Desktop | provider-routed | https://block.github.io/goose/ |
| Mistral Vibe | CLI | provider-routed only if a custom endpoint is officially supported and verified | https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli |
| Continue CLI (`cn`) | CLI | provider-routed only with verified custom-model configuration | https://docs.continue.dev/cli/quickstart |
| Cline | VS Code extension | extension/provider-routed | https://docs.cline.bot/provider-config/openai-compatible |
| Continue | VS Code/JetBrains extension | extension; verify endpoint support separately | https://docs.continue.dev/ |
| Kilo Code | VS Code extension | extension; verify endpoint support separately | https://kilocode.ai/docs/ |
| Roo Code | VS Code extension | extension; verify official custom-provider support | https://docs.roocode.com/ |

### Installable but likely native-account or restricted

Do not route these through CodeSwitchboard unless current official documentation explicitly supports the required custom endpoint. An `--endpoint` flag that still requires the vendor's own API key is not proof of arbitrary-provider compatibility.

| Target | Surface | Expected mode | Official starting point |
| --- | --- | --- | --- |
| GitHub Copilot | CLI + IDE extensions | native-account | https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli |
| Cursor | IDE + Agent CLI | native-account; its BYOK feature is limited and requests still pass through Cursor infrastructure | https://docs.cursor.com/en/cli/overview |
| Windsurf | IDE + terminal tooling | native-account/workspace-only | https://docs.windsurf.com/ |
| Kiro | IDE + CLI + Crew | native-account | https://kiro.dev/docs/cli/installation/ |
| Amazon Q Developer | CLI + IDE extensions | native-account | https://github.com/aws/amazon-q-developer-cli |
| Auggie | CLI | native-account | https://docs.augmentcode.com/cli/overview |
| Amp | CLI | native-account; Windows support may require WSL | https://ampcode.com/docs/cli |
| JetBrains AI Assistant / Junie | IDE plugin | native-account extension | https://www.jetbrains.com/help/ai-assistant/installation-guide-ai-assistant.html |
| GitHub Copilot in VS Code/Visual Studio/JetBrains | extension | native-account extension | https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-extension |

### WSL, container, or advanced-agent candidates

Treat these as optional. Detect and explain prerequisites; never silently install WSL, Docker, or a VM.

| Target | Surface | Expected mode | Official starting point |
| --- | --- | --- | --- |
| OpenHands | CLI + local web app | WSL/container, BYOK | https://docs.openhands.dev/openhands/usage/cli/installation |
| SWE-agent | CLI/container | WSL/container, BYOK if officially supported | https://github.com/SWE-agent/SWE-agent |
| Tabby | self-hosted server + editor extensions | advanced local service | https://tabby.tabbyml.com/docs/ |
| Open Interpreter | CLI | advanced general-purpose agent; verify coding and endpoint behavior | https://docs.openinterpreter.com/ |
| Plandex | CLI | advanced agent; verify maintenance and provider configuration | https://github.com/plandex-ai/plandex |

Also research current official status for AiderDesk, PearAI, GPT Pilot/Pythagora, Mentat, and other commonly cited coding agents. Add them only if they are active, uniquely useful, and verifiable. Record rejected or deprecated candidates with a reason so they are not repeatedly rediscovered.

## Build a data-driven registry

Refactor target metadata only as much as necessary to avoid a growing chain of target-specific conditionals. Each target definition should be able to declare:

- stable ID, display name, surface, mode, homepage, documentation URL, license if known;
- supported operating systems and Windows support level (`native`, `WSL`, `container`, or unavailable);
- executable names and verified Windows candidate paths;
- version command and minimum supported version;
- prerequisites such as Node, Python/uv, Git Bash, WSL, Docker, or an editor;
- official install strategies, ordered by preference;
- whether installation needs elevation;
- routing protocol and configuration strategy;
- model-list and model-switch strategy;
- isolated config/profile location and cleanup/restore behavior;
- non-interactive smoke-test command and success parser;
- whether a vendor login is required;
- capability flags for tools, streaming, images, reasoning, MCP, ACP, and system-prompt override;
- implementation and verification status.

The dashboard and `csb targets` must derive from the same registry. Do not copy target lists into multiple UI and server files.

## Installation UX and commands

Add these discoverable commands, with equivalent dashboard actions:

```text
csb catalog [--mode provider-routed|native-account|extension|wsl]
csb target info <target-id>
csb install <target-id>
csb install --recommended
csb update <target-id|--installed>
csb doctor [target-id]
csb test <target-id|--routed>
csb uninstall-routing <target-id>
```

Requirements:

- Never silently bulk-install the full catalog. `--recommended` means the small provider-routable native-Windows set and must show the planned installations before changing the machine.
- Use official package sources. Prefer `winget`, then an official npm package, then `uv tool`, then a signed official release installer. Avoid `curl | shell` on Windows when a package-manager or signed release exists.
- Resolve package ID, package version, publisher, executable path, and `--version` after install. A zero installer exit code alone is not success.
- Make installation idempotent. An already installed supported version should return success without reinstalling.
- Never install an unofficial namesake package.
- Never require administrator rights unless the official installer truly requires them. Explain every UAC prompt before opening it.
- Do not uninstall, overwrite user configuration, or change an existing default account during installation.
- Store install receipts and verification results, but never secrets.

## Routing and authentication rules

- Prefer an application's documented custom OpenAI-compatible configuration when it supports chat completions, tool calls, and model IDs correctly.
- Use the existing local bridges when an application requires Responses, Anthropic Messages, or Gemini protocol behavior.
- Give child targets only a loopback URL and a dummy loopback credential whenever possible. The real provider key stays inside CodeSwitchboard.
- Use a fresh, isolated per-launch config or profile when the target supports one. Do not corrupt the user's ordinary profile.
- If an app requires modifying user-level settings, back up the exact affected values, tag CodeSwitchboard-owned changes, provide one-click restore, and never overwrite administrator-managed policy.
- Do not patch proprietary binaries, bypass licensing, fake OAuth, steal session cookies, or suppress legitimate subscription checks.
- If a target requires its own account, show **Requires <vendor> account** before launch and do not display **Provider routed**.
- Refresh `/v1/models` from the selected provider and preserve exact provider model IDs. Handle unavailable and end-of-life models with a useful retryable selection error.
- Prefer the target's native model picker (`/models`, `/model`, or UI picker). Use the CodeSwitchboard terminal selector only when no usable native picker exists.
- Where officially supported, expose a system-prompt/profile selector separately from model selection. Never copy leaked or proprietary system prompts; ship only original, licensed, or user-supplied prompts with source/license metadata.

## Restart and recovery

Installing or updating a target must not strand the user when CodeSwitchboard restarts.

1. Persist selected provider, model, target, workspace, and non-secret preferences before restart.
2. Keep provider keys in the existing DPAPI-protected store.
3. Stop bridges and child launch helpers cleanly.
4. Restart the local server through the normal `csb server` path.
5. Poll the health endpoint with a bounded timeout.
6. Reopen the previous dashboard route and restore its selections.
7. Rescan installed targets and show the new target without requiring another restart when feasible.
8. If recovery fails, print the exact log path and a copyable recovery command.
9. `csb stop` must stop the server and every CodeSwitchboard-owned bridge without terminating unrelated vendor-app sessions.

Do not automatically relaunch an AI tool after a crash if doing so could repeat billable requests or file-changing actions.

## Verification: “works” means a real response

Create adapter-level tests and an end-to-end verifier. For each target:

1. Confirm the official executable and version.
2. Confirm detection from a clean PowerShell session, not just the current process `PATH`.
3. Generate or inject an isolated routing configuration.
4. Confirm that the selected model appears or is accepted.
5. Against a deterministic local mock provider, send exactly:

   `Reply with exactly CODESWITCHBOARD_OK and do not use tools.`

6. Require a parsed assistant response containing `CODESWITCHBOARD_OK`. Opening a window, rendering a prompt, or exiting zero is insufficient.
7. For tools that support tool use, run a separate safe test in a temporary workspace that reads a fixture file and does not modify the user's repository.
8. Restart CodeSwitchboard, verify persistence, and repeat the message smoke test.
9. Run restore/uninstall-routing and verify that the user's original configuration is byte-for-byte unchanged or semantically equivalent.
10. If the real selected provider is tested, send only the one short deterministic message and display that this consumes provider quota. Never send a live Codex test unless explicitly authorized.

Classify every result as one of: `verified`, `installed-unverified`, `login-required`, `unsupported-protocol`, `missing-prerequisite`, `provider-error`, `model-unavailable`, or `failed`. Never convert an unknown or timeout into “working.”

## Test architecture

- Unit-test catalog validation, install command construction, executable discovery, config generation, secret redaction, restore behavior, and protocol adapters.
- Use fixture executables and local mock servers in CI; do not install third-party programs during ordinary unit tests.
- Put opt-in machine tests behind a separate command and make their machine changes explicit.
- Add a regression test ensuring every provider-routed target has a smoke-test adapter and every target that changes settings has a restore adapter.
- Add a test that scans logs, generated configs, process arguments, and persisted state for known fixture secrets.
- Run the full existing suite after every target group, then the end-to-end target verifier.

## Delivery phases

1. **Catalog and diagnostics:** data model, catalog UI/CLI, official links, detection, modes, prerequisites, no installations yet.
2. **Native Windows routed CLIs:** Crush, Qwen Code, Kilo CLI, goose CLI, then Mistral Vibe and Continue CLI only after endpoint compatibility is proven.
3. **Extensions and desktop apps:** goose Desktop and isolated VS Code profiles for Cline, Continue, Kilo, and Roo Code. Never mix extension verification with plain VS Code launch verification.
4. **Native-account targets:** offer install/launch for Copilot CLI, Cursor Agent, Kiro, Amazon Q, Auggie, and similar tools with honest login labels.
5. **Optional WSL/container targets:** OpenHands and other advanced tools, only after prerequisite UX is complete.

Complete and test one phase before starting the next. If a target cannot pass its smoke test, leave it disabled or experimental with its exact failure; do not weaken the acceptance test.

## Required output

At completion, provide:

- the final catalog grouped by compatibility mode;
- files changed and architectural decisions;
- exact official install source for every implemented target;
- installed/detected versions;
- a per-target verification table with actual status and last-tested time;
- restart/persistence and restore test results;
- security notes, especially how keys and temporary configs are handled;
- unsupported/rejected targets and why;
- commands the user can run immediately.

Do not promise that every third-party tool works. Demonstrate what works, label what needs a native account, and make failures actionable. The result is successful when a new user can install a supported target, restart CodeSwitchboard, select a provider/model/workspace, launch it, receive `CODESWITCHBOARD_OK`, switch models through a supported picker, and restore normal configuration without manual repair.

---

## Research notes (verified 2026-09-08)

- Crush documents Windows support, npm/WinGet installation, custom providers, and model switching: https://github.com/charmbracelet/crush
- Qwen Code documents Windows, third-party providers, and OpenAI base URL/key flags: https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md
- Kilo Code publishes its CLI as `@kilocode/cli`: https://github.com/Kilo-Org/kilocode
- goose provides Windows Desktop/CLI and 15+ providers: https://block.github.io/goose/
- Mistral Vibe uses `uv tool install mistral-vibe` and requires Python 3.12+: https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli
- Continue CLI uses `cn`, Node 20+, and configurable models: https://docs.continue.dev/cli/quickstart
- OpenHands documents Windows through WSL: https://docs.openhands.dev/openhands/usage/cli/installation
- GitHub Copilot CLI requires a Copilot plan and GitHub authentication: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
- Kiro requires Kiro authentication even though current versions support native Windows CLI: https://kiro.dev/docs/cli/installation/
- Auggie requires an Augment login: https://docs.augmentcode.com/cli/overview
- Amp requires an Amp account and documents Windows through WSL: https://ampcode.com/docs/cli
- Cline officially supports arbitrary OpenAI-compatible endpoint, key, and model settings: https://docs.cline.bot/provider-config/openai-compatible

