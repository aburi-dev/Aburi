import { SITE } from "./head.ts"

// vitepress-plugin-llms fills `{toc}` from the sidebar.
export const LLMS_TXT = `# Aburi

> Semantic code review for pull requests: Aburi reads a change the way a senior reviewer does, then
> writes what it did as Markdown your CI can gate on.

Aburi is a deterministic static-analysis CLI for TypeScript and JavaScript repositories. \`aburi scan\`
turns a workspace into a JSON IR of its Symbols, Components and effects; \`aburi diff\` compares two
revisions and writes a Markdown report of what the change did: endpoints added or removed, guards
dropped, database writes gained, files that only moved. It holds no model and calls none.

## When to use Aburi

- Reviewing a pull request in a TypeScript or JavaScript repository, when the question is what the
  change does rather than which lines it touches.
- Gating CI on behaviour: \`aburi diff main..HEAD --fail-on removed\` exits \`3\` when a Symbol is
  removed (a removed duplicate of another is left out), and the GitHub Action posts the report as a
  pull request comment.
- Checking an agent's own edits: scan, edit, scan again, and diff the two scans to see what the edit
  changed in behaviour.
- Answering what a Component exposes, or which effects (database reads and writes, RPC calls,
  published events) one function reaches.
- Seeing through refactors: renames, moves and reformatting are matched up and reported apart from
  the behaviour changes.

Each framework it understands is a plugin package to install beside the CLI: NestJS, Next.js App
Router, Express, tRPC and React, with Prisma, Drizzle and other effect plugins for what a call does.

## When not to use it

- Repositories in languages other than TypeScript and JavaScript: no language plugin parses them yet.
- Line-level style or lint feedback, type errors, or runtime behaviour: Aburi reads source statically.

## How an agent calls it

Aburi needs Node.js 24 or newer and a git repository.

- MCP: install \`@aburi/mcp\` beside the CLI and its plugins
  (\`pnpm add -D @aburi/mcp @aburi/cli @aburi/lang-typescript\`, plus the framework and effects plugins
  the project uses), then register it from the workspace root, for Claude Code with
  \`claude mcp add aburi -- pnpm exec aburi-mcp\`. It serves the tools \`scan\`, \`workspace\`,
  \`component\`, \`explain\` and \`diff\`. See
  [MCP server for AI coding agents](${SITE}/guide/ai-agents.md).
- CLI: install \`@aburi/cli\`, \`@aburi/lang-typescript\` and the framework and effects plugins the
  project uses (\`pnpm exec aburi init --with-suggestions\` names the ones it detected that are not
  installed), then run \`pnpm exec aburi diff main..HEAD\`. It writes the report to \`.aburi/diff.md\` and
  the structured diff to \`.aburi/diff.json\`, reading the head from the working tree, so uncommitted
  edits count. See the [CLI reference](${SITE}/reference/cli.md).
- Every page of this site is also served as Markdown: request it with \`Accept: text/markdown\`, or
  append \`.md\` to its path (a section index such as \`/showcase/\` is \`/showcase.md\`, and \`/\` is this
  file).

## Table of Contents

{toc}
`
