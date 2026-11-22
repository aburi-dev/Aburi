---
"@aburi/core": minor
---

Resolve an import of a name an export clause gives a declaration of the module. `string()` through `import { string } from "./types"`, where `types.ts` writes `function stringType() {}` and `export { stringType as string }`, now reaches `stringType` at `high` confidence, and so do an alias or a namespace import of the module (`z.string()`), a barrel that re-exports the name, and a dotted call through a class exported under another name (`export { Hono as HonoBase }`). The declaration the clause names is taken over one the module declares under the exported name, which the module then does not export as that name, and so it is where a drop rule removed it: such a call stays unresolved where it used to reach the namesake. The others used to stay unresolved.

On the pinned benchmark repositories this resolves 1,606 more calls on `zod` (13,796 → 15,402), 1,098 on `hono` (5,659 → 6,757) and 14 on `cal-com`.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
