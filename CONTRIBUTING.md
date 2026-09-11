# Contributing

Use Windows, PowerShell, Node.js 20 or newer, and Git. Clone the repository,
run `npm ci`, then `npm test`. Start development with `npm start`.

Submit focused pull requests describing the problem, change, and test results.
Never include provider keys, account files, local conversation history, or
unredacted logs. Keep existing user configuration intact.

Target definitions live in `lib/target-catalog.js` and `lib/target-registry.js`;
installation and discovery live in `lib/target-manager.js`. Each target should
document its official source, supported protocol, account requirements, model
switching, and restore behavior. Opening an executable does not prove inference.

Test adapters against a local mock first. Live tests require your own provider
credentials and may cost money. Record the tool version and distinguish mock
results from live-provider results. Do not change an installed application's
account configuration as a side effect of ordinary automated tests.

Contributions to original project code are submitted under the MIT license.
Preserve applicable notices and licenses when incorporating third-party code.
