---
"@aburi/core": patch
"@aburi/cli": patch
---

A `pnpm-workspace.yaml` that does not parse or does not list its packages, or a root `package.json` that does not parse, now exits 2 after `Failed to resolve components:` (`aburi scan`) or `Failed to detect components:` (`aburi init`), as a workspace package's manifest already did. The YAML error now names the parser's reason with its line and column.
