---
"@aburi/cli": minor
"@aburi/github-action": patch
"@aburi/mcp": patch
---

A plugin named by package (`lang-typescript`, `@myorg/aburi-x`) is now imported from the workspace's own `node_modules` first, and from where the CLI is installed only when the workspace has no such package. A CLI run by `pnpm dlx`, installed globally, or started by the MCP server from its own install now loads the plugins the project installed, and the action's `cli: dlx` loads them once the workspace is installed. A workspace copy that cannot be imported fails the scan instead of falling back to the CLI's copy, and a package neither place holds fails naming both. `aburi diff` imports the base scan's plugins from the head's `node_modules`.
