---
"@aburi/cli": minor
---

`aburi init --with-suggestions` prints the command that installs the suggested plugins for the workspace's package manager on a new `install:` line: `pnpm add -D -w` at a pnpm workspace root, `yarn add -D -W` at a Yarn 1 workspace root, `bun add -d`, `npm install -D`, and so on, where it used to suggest `pnpm add -D` everywhere. The command goes into the config as a comment only when the output is `.jsonc`, so an `aburi.json` stays plain JSON. A plugin counts as installed when the workspace's own imports find it, so an empty directory under `node_modules/@aburi/` no longer silences its suggestion.
