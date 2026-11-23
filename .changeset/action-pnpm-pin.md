---
"@aburi/github-action": minor
---

Under `cli: dlx`, the action no longer fails at "Setup pnpm" in a repository whose root `package.json` pins pnpm. `pnpm-version` now defaults to empty, which installs the version `packageManager` or `devEngines.packageManager` pins, and pnpm 10 when there is no pin; `pnpm/action-setup` refused the old default `10` beside any `packageManager` pin. A `pnpm-version` you set is still passed as it is, so beside a `packageManager` pin it has to equal that version, and one holding a line break is refused up front with exit 2. The workflow examples no longer pass `version: 10` to `pnpm/action-setup`, which refuses it in a repository that pins pnpm.
