# Security

CodeSwitchboard is intended for a trusted Windows user on a local computer.
Do not expose its dashboard or bridges to the internet or a shared network.
The fixed loopback credential is not a substitute for multi-user authentication.

Provider keys saved through the dashboard are encrypted with Windows DPAPI
for the current Windows user. They are decrypted in memory to call providers.
Selected models, targets, and workspaces are saved locally. Treat local backups,
process memory, and debugging logs as potentially sensitive. Prompts and code
sent to a selected provider are subject to that provider's data policies.

For a vulnerability, use GitHub's private vulnerability reporting feature on
this repository if enabled. Otherwise open an issue requesting a private contact
channel without including exploit details or credentials. Never publish keys.
Revoke a key at its provider if it has been exposed.

The current development branch receives fixes; older snapshots have no promised
support window. This project has not received an independent security audit.
