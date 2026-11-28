---
description: "The aburi.json settings people change in practice: excluded files, test code, plugins, components, noisy helpers and in-house framework hints."
---

# Configuration

`aburi init` writes an `aburi.json` at your workspace root, and for most
projects that generated file is the last you will think about it:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"],
  "effects": ["effects-drizzle"],
  "components": [
    { "id": "storefront", "name": "storefront", "roots": ["apps/storefront"], "languages": ["ts"], "frameworks": ["nextjs", "react"] }
  ]
}
```

Every field is optional, but `aburi scan` needs a language plugin to parse
anything: with `{}`, or with no config at all, it exits `2` and says so. The plugin
lists are never inferred, which is what `aburi init` writes them for: one plugin
for each language and framework it detected, and one for each library an effects
plugin classifies that your manifests depend on, such as `@prisma/client` or
`drizzle-orm`. Components are inferred from your workspace manifests when the
config declares none. `aburi init` writes the ones it found, so from then on the
list is the whole set: see [Define components](#define-components). The sections
below cover what people change in practice.

::: tip JSONC is fine
Name the file `aburi.jsonc` if you want comments. Keep the `$schema` line either
way. It gives you completion and validation in most editors.
:::

## Exclude files

Generated code, vendored trees, and fixtures rarely belong in the report.

```jsonc
{
  "ignore": ["src/generated/**", "test/fixtures/**", "**/*.pb.ts"]
}
```

Tests are scanned like the rest of the workspace. A file's top-level code is
reported as one entry, `<module>`, and in a test file that code is its
`describe` and `it` blocks, so an edit to a test shows up as a change to that
file's `<module>`. Like the file's other Symbols, it is test code: the report
folds it into the `🧪 Test files` section, and the gate can skip it
([Mark test code](#mark-test-code)), so tests need no `ignore` entry.

Write POSIX globs relative to the workspace root. Aburi adds them to the
built-in exclusions rather than replacing them. A `*` or `**` matches a name
that starts with a dot too, so `docs/**` also leaves out `docs/.vitepress`.

A directory whose name starts with a dot is scanned like any other: a GitHub
Action's source under `.github/actions`, Storybook's configuration in
`.storybook` and a VitePress theme in `docs/.vitepress` are in the report. The
built-in exclusions keep out Yarn's `.yarn`, `.pnp.cjs` and `.pnp.loader.mjs`
and VitePress's `.vitepress/cache`, beside dependency, build and cache
directories such as `node_modules`, `dist` and `.next`.

Aburi never reads `.git`, and it does not scan another checkout kept inside the
repository as part of it: a linked worktree under `.worktrees` or
`.claude/worktrees`, a nested repository and a submodule are left out, since git
counts none of their files as the repository's.

Aburi honours `.gitignore` by default, every one in the tree, the way git reads
them. Turn that off when you want to analyse build output on purpose:

```jsonc
{ "respectGitignore": false }
```

A directory Aburi may not list ends the run with exit 1 and names it, because every file
under it would otherwise be missing from the analysis without a word. One that `.gitignore`
excludes is passed over while `.gitignore` is honoured, as git passes over it, so a data
directory a container owns does not stop a scan. The rule has to exclude the directory
itself: `data/pg/*` leaves `data/pg` to be listed. A directory a `pnpm-workspace.yaml` or
`workspaces` pattern names is the exception, because pnpm and npm never read `.gitignore`.

## Mark test code

Tests, fixtures and mocks are scanned like the rest of your code, so the calls out of them stay in
the graph, but they are rarely what a pull request asks a reviewer about. Aburi marks the Symbols
of a test file, lists their changes in a folded `🧪 Test files` section at the end of `diff.md`,
and lets the gate skip them with `--fail-on-scope non-test` (or the action's `fail-on-scope`).

With no `testFiles` in your config, these files are test code:

```
**/*.test.*  **/*.spec.*  **/*.test-d.*  **/*.spec-d.*
**/__tests__/**  **/__mocks__/**  **/__fixtures__/**
**/test/**  **/tests/**  **/e2e/**
```

Set `testFiles` to change the list. Write `"..."` where the default list goes to add patterns to
it. It keeps up with the default when a release adds a pattern, which a copy of it would not:

```jsonc
{
  "testFiles": ["...", "examples/**"]
}
```

A pattern that starts with `!` takes files back out, so `["...", "!src/test"]` keeps a production
`src/test/` out of the fold.

A list without `"..."` replaces the default one, for a workspace whose tests follow a layout of
their own:

```jsonc
{
  "testFiles": ["src/**/*.check.ts"]
}
```

The globs read like `ignore`'s: `fixtures` or `fixtures/` marks the root's `fixtures/` directory,
and `**/fixtures/**` marks every one. `[]` marks nothing, and `"!..."` is an error: leave `"..."`
out to drop the default.
Use `testFiles` rather than `ignore` for tests: an ignored file is never read, and the calls a
test makes leave the graph with it.

## Choose plugins

Three lists, one per plugin kind:

```jsonc
{
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"],
  "effects": ["effects-drizzle"]
}
```

A bare name resolves under the `@aburi` scope, so `"effects-drizzle"` means
`@aburi/effects-drizzle`. Third-party plugins need their full package name
(`"@myorg/aburi-effects"`), and a path starting with `./` loads a local file.
The plugins under `@aburi` are named with their kind as a prefix (`lang-`,
`framework-`, `effects-`), so a bare name of lowercase letters and digits alone, such
as the language id `"ts"`, stops the scan with exit 2 and names the plugin to write
instead.

Order matters in `frameworks` and `effects`. The first plugin to classify a symbol
or recognise a call wins, so put your project-specific plugins first, and list
`framework-next` ahead of `framework-react`, as `aburi init` does: a Next.js route
handler that renders JSX is then a route rather than a component.

Options for an individual plugin go under `pluginOptions`, keyed by the
plugin's manifest name. Of the plugins that ship with Aburi, `effects-prisma`
takes one: `clientModules`, the modules a Prisma client generated to a custom
`output` is imported from. An entry matches an import whose last path segments
are the entry's, so `"db/client"` matches `"../db/client"` and
`"@/db/client.ts"`. A client generated to `generated/prisma`, Prisma's default,
needs no entry. A third-party plugin that takes options documents them:

```jsonc
{
  "effects": ["effects-prisma", "@myorg/aburi-effects"],
  "pluginOptions": {
    "effects-prisma": { "clientModules": ["db/client"] },
    "effects-myorg": { "queues": ["billing", "mail"] }
  }
}
```

A key that is not the manifest name of a plugin the scan loaded (a misspelling,
or a plugin none of the three lists enables) gets a warning on stderr naming the
plugins that did load. A key for `hint-<name>`, the plugin Aburi builds from each
[`frameworkHints`](#teach-it-your-in-house-framework) entry, gets a warning too:
that plugin takes no options, so its rules go in the entry.

## Define components

Components are the boxes in `workspace.md`, and the unit Aburi writes each
`components/*.md` for. It infers them from your workspace manifests. Declare
them yourself when that inference does not match how you think about the
codebase:

```jsonc
{
  "components": [
    {
      "id": "checkout",
      "name": "Checkout",
      "roots": ["apps/storefront/src/app/checkout", "packages/pricing"],
      "publicApi": ["packages/pricing/src/index.ts"]
    }
  ]
}
```

Declaring components turns detection off: the components you list are the
whole set, with no partial merge, so write out every field you care about. A
workspace package the list leaves out belongs to no component, and `aburi scan`
names each one the IR has symbols from, so a package added after `aburi init`
wrote the list is named once it has symbols. Add it to the list, or delete
`components` to have every package detected again. To leave a package out on
purpose, exclude its files with `ignore`. A package one of your roots lies inside,
such as `apps/storefront` in the example above, is not named: declaring part of it
leaves the rest out on purpose.

`roots` is also what decides which component a symbol counts towards: a file
belongs to the component whose root is the deepest path containing it, so a
component rooted at `apps/storefront/src/app/checkout` takes those files back
from one rooted at `apps/storefront`. (A root usually names a directory, but one
naming a single file works and claims exactly that file.) A file under no root
at all — `scripts/` beside your packages, say — belongs to no component: its
symbols are counted in `workspace.md`'s own kept/dropped totals and appear in the
diff, but in neither the Components table, nor the effect surface's `components`
column, nor any `components/*.md`.

`frameworks` names the frameworks a component uses (`nextjs`, `react`, `express`,
…), as detection records them. Where it lists any, a plugin for a framework
detection knows and the list leaves out does not classify the component's files:
a component listing only `express` is not read by `framework-react`. Leave
`frameworks` out to have every configured plugin read the component. A
`frameworkHints` entry applies everywhere either way.

## Quiet down noisy helpers

Logging and metrics calls show up in almost every symbol without telling you
much. `suppress` takes identifier prefixes and drops them from effects and
calls. `keep` carves exceptions back out, and beats everything else:

```jsonc
{
  "suppress": ["myLogger", "metrics"],
  "keep": ["myLogger.audit", "@Transaction"]
}
```

An entry starting with `@` in `keep` names a decorator. Anything else names a
callee.

## Teach it your in-house framework

If your team has its own decorators, you can get boundary detection without
writing a plugin:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" }
      },
      "classNamePatterns": {
        "*Handler": { "extKind": "framework:acme:handler" }
      }
    }
  ]
}
```

Analysis output shows these kinds as `framework:hint:acme:controller`, so they
never collide with a published `framework-acme` plugin. A rule can also add a
`derivedBy` reason, or set `drop: true` to drop the symbols it matches. A plugin
listed in `frameworks` goes first: a class it recognizes keeps its
classification.

For anything heavier, such as parsing a new language or recognising call shapes,
write a [plugin](../extend/plugin-development.md) instead.

## Move the output

```jsonc
{ "output": { "dir": "reports/aburi" } }
```

`scan` and `diff` write there, and `explain` reads the analysis back from there.
The `--output-dir` flag beats this setting when you pass both.

## Limits

The defaults suit a normal repository. Reach for these when a scan drags, or
when it skips files you expected to see:

```jsonc
{
  "maxFileSizeBytes": 2097152,
  "parseTimeoutMs": 5000,
  "classifyTimeoutMs": 50,
  "minParsedFileRatio": 0.9
}
```

`minParsedFileRatio` is the one with teeth, and it has no default. Set it, and a
scan that parsed less than that share of the files it discovered exits `3`
rather than reporting on a fraction of your code without saying so. Worth
setting in CI.

## All fields

| Field | Default | Purpose |
|---|---|---|
| `ignore` | `[]` | Extra glob patterns to skip. |
| `respectGitignore` | `true` | Honour `.gitignore` files, in the scan and in finding components. |
| `testFiles` | test-file globs | Files whose Symbols are test code: reported apart in `diff.md` and skipped by `--fail-on-scope non-test`. |
| `languages` | `[]` | Language plugins to load. A scan needs at least one; `aburi init` writes the ones it detects. |
| `frameworks` | `[]` | Framework plugins, in priority order. |
| `effects` | `[]` | Effects plugins, in priority order. |
| `pluginOptions` | `{}` | Options for individual plugins, keyed by manifest name. |
| `components` | autodetect | Explicit component boundaries. |
| `suppress` | `[]` | Identifier prefixes to drop from effects and calls. |
| `keep` | `[]` | Exceptions to `suppress` and to the built-in drop rules. |
| `frameworkHints` | `[]` | Decorator and class-name rules for an in-house framework. |
| `output.dir` | `.aburi` | Where Aburi writes artifacts and reads them back. |
| `strict` | `true` | Abort when a plugin emits vocabulary it never declared. `false` keeps it and lists it in `aburi-vocab-discovered.json`. |
| `maxFileSizeBytes` | `2097152` | Aburi skips files above this size. |
| `parseTimeoutMs` | `5000` | Per-file budget for parse, extract, and walk. |
| `classifyTimeoutMs` | `50` | Per-call budget for an effects plugin. A call over it keeps its result and is listed in `stats.effectClassifyTimeouts`. |
| `minParsedFileRatio` | *(unset)* | Smallest share of discovered files a scan may parse and still pass. |
| `lsp` | off | Opt-in enrichment from a language server you install: column ranges and `this.` / `super.` call resolution. Turn it on with `enabled` (or `aburi scan --lsp`); `servers` is keyed by language plugin id: `"lsp": { "enabled": true, "servers": { "ts": { "command": "typescript-language-server", "args": ["--stdio"] } } }` for `lang-typescript`. |

The [JSON Schema](https://aburi.dev/schema/aburi.config.v1.json) is the
authoritative definition — that URL is the one the `$schema` line points at, and it
serves the same file the loader validates against. The
[config design doc](../design/config.md) carries the reasoning behind each field.
