# CodeSwitchboard target status

Last updated: 2026-09-08

This document distinguishes adapter implementation from inference verification. A detected executable or successful `--version` command does not prove that a provider route works.

## Machine-safe verification

The command below uses a temporary workspace and a deterministic localhost mock provider. It does not contact NVIDIA or any other live provider and does not test Codex:

```powershell
node scripts\verify-target-messages.js crush-cli qwen-cli kilo-cli
```

Latest observed result:

| Target | Installed version | Mock routed inference | Request evidence | Status |
| --- | ---: | --- | ---: | --- |
| Crush | 0.89.0 | `CODESWITCHBOARD_OK` | 2 | verified against local mock |
| Qwen Code | 0.23.0 | `CODESWITCHBOARD_OK` | 1 | verified against local mock |
| Kilo Code CLI | 7.5.16 | `CODESWITCHBOARD_OK` | 1 | verified against local mock |
| Hermes Agent | 0.21.1 | `CODESWITCHBOARD_OK` | 2 | verified against local mock |

The verifier checks that the mock provider received an authenticated request through the CodeSwitchboard bridge, that provider/model prefixes were translated, and that the CLI exited normally. It does not claim NVIDIA-provider success.

## Catalog status

- `implemented` means CodeSwitchboard has an adapter/configuration strategy.
- `unverified` means no fresh end-to-end inference evidence has been recorded for that target in this handoff. The three recommended additions below are marked `verified` in the catalog because this handoff contains fresh local-mock evidence; this is not live NVIDIA-provider verification.
- `cataloged` means visible in the catalog but not launch-enabled.
- `native-account` targets require their vendor account and are not provider-routed.
- Extensions are catalog entries only until isolated editor-profile installation and verification are implemented.

The table records historical local-mock results, not universal compatibility. Existing Codex, Claude, OpenCode, Aider, Pi, Cline, DeepSeek Harness, Hermes, and Gemini adapters should not be treated as freshly verified solely from catalog metadata. Cursor Agent CLI, Cursor, Windsurf, Kiro CLI, Kiro IDE, and Void were removed from the active catalog.

## Official installation sources

- Crush: WinGet package `charmbracelet.crush`.
- Qwen Code: npm package `@qwen-code/qwen-code`.
- Kilo Code CLI: npm package `@kilocode/cli`.

## Known limitations and safety notes

- Cline's interactive `/model` picker is affected by an upstream Cline CLI bug: its bundled Ink (React-for-terminals) runtime aborts with `Error: Text must be created inside of a text node` while rendering the picker. `scripts/repro-cline-model.js` reproduces it against a deterministic localhost mock (Cline 3.0.61, latest at the time of testing), and no request to the model endpoint precedes the crash, so CodeSwitchboard's bridge shape is not implicated. Model selection still works at launch (`--model`), via `cline auth`, and by editing the isolated `providers.json` that CodeSwitchboard writes per launch; the picker itself must be fixed upstream.

- No live provider test was run. Do not infer NVIDIA quota or model availability from the mock pass.
- No live Codex inference test was run.
- Claude Desktop uses an explicit managed `inferenceModels` registry list with model discovery disabled because Claude Desktop auto-discovery can hide opaque non-Claude IDs. Restore removes only CodeSwitchboard-owned policy values.
- Provider keys remain inside the CodeSwitchboard process or encrypted DPAPI storage; child tools receive only `codeswitchboard-local` for routed local bridges.
- Installation endpoints now execute asynchronously so a long WinGet/npm installation does not block the dashboard event loop. Installers remain explicit user actions.
- Qwen’s earlier Windows libuv assertion was caused by premature process termination in the old verifier. The current verifier waits for clean exit; Qwen passed afterward.
- Hermes is launched in its documented classic `--cli` mode directly, rather than placing its interactive terminal inside the CodeSwitchboard model-wrapper PTY. This prevents raw terminal escape sequences from being inserted into the prompt. Hermes switches models with its native `/model` command.

## Next work

1. Add persistent verification receipts/status updates after successful machine-safe tests.
5. Add restart/persistence and byte-for-byte restore tests for each settings-changing adapter.
6. Add safe fixture-reading tool-call verification to the machine verifier; current mock verification is message-only.
