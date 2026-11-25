---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": minor
"@aburi/framework-next": minor
---

Read a Next.js `redirect()`, `permanentRedirect()`, `notFound()`, `forbidden()` or `unauthorized()` as an exit, so `if (!session) redirect("/login")` is a guard and removing it is a logic change, as removing `if (!session) throw …` already was.

A plugin manifest may now declare, under the optional `provides.exitCalls`, functions a module exports that never return to their caller: `{ "module": "next/navigation", "exports": ["redirect", …] }`. `VocabRegistry.isExitCall(module, exported)` answers for every registered manifest. `@aburi/lang-typescript` reads a call through the import that binds its callee (a named, aliased or default import, or a member of a module bound whole by `import * as nav` or `import nav = require(…)`), and an `if` whose consequence makes such a call is a guard. A local of the same name is not one. `@aburi/framework-next` declares the five functions from `next/navigation`.

Whether such an `if` is a guard or a `branch` depends on the plugins a scan loads, so adding or removing `@aburi/framework-next` moves `logic` for the Symbols that make these calls. On a large App Router codebase, dozens of guards appear, most of them in pages. An `aburi diff` against an IR an earlier version wrote reports their logic as changed; one that scans both sides with this version does not.

`@aburi/lang-typescript` now needs a host whose plugin registry has `isExitCall`, so update `@aburi/cli` together with it. Under an older CLI the scan ends as the plugin initializes, with `plugin-init-failed` and exit code 3, rather than withdrawing every file whose body calls an import.
