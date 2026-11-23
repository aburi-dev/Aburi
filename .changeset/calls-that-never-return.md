---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": minor
"@aburi/framework-next": minor
---

Read a Next.js `redirect()`, `permanentRedirect()`, `notFound()`, `forbidden()` or `unauthorized()` as an exit, so `if (!session) redirect("/login")` is a guard and removing it is a logic change, as removing `if (!session) throw …` already was.

A plugin manifest may now declare, under the optional `provides.exitCalls`, functions a module exports that never return to their caller: `{ "module": "next/navigation", "exports": ["redirect", …] }`. `VocabRegistry.isExitCall(module, exported)` answers for every registered manifest. `@aburi/lang-typescript` reads a call through the import that binds its callee (a named, aliased or default import, or a member of a namespace import), and an `if` whose consequence makes such a call is a guard. A local of the same name is not one. `@aburi/framework-next` declares the five functions from `next/navigation`.

Whether such an `if` is a guard depends on the plugins a scan loads, so adding or removing `@aburi/framework-next` moves `logic` for the Symbols that make these calls. On the pinned `cal-com` checkout, 31 guards appear in 23 Symbols, most of them App Router pages. An `aburi diff` against an IR an earlier version wrote reports their logic as changed; one that scans both sides with this version does not.
