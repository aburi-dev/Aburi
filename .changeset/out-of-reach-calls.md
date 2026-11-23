---
"@aburi/core": minor
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

Bucket as `external` every unresolved call no declaration the scan read can be the callee of, not only one through a package import. That covers a global the runtime or a test runner provides (`setTimeout(…)`, `expect(x).toBe(1)`, `describe(…)`), where nothing around the call declares the leading name and no Symbol's qualified name starts with it, and a member that no Symbol is named and no module exports (`items.map(…)`, `this.emit(…)` in a class extending a package's `EventEmitter`). A function's `call` and `apply` run the function, so they are never counted by name, and a call through CommonJS's `module`, `exports` or what `require(…)` gives back is no global's. The check reads names, not declarations, so a member a workspace file assigns without declaring it as a Symbol counts too. `external` now comes right after `local-scope` in the bucket order, ahead of `dynamic` and `ambiguous`, and a call that moves there from `ambiguous` no longer lists its candidates.

This change alone resolves no call differently; counts move between buckets. On the pinned benchmark repositories, checked out without their dependencies installed, authored `external` grows from 87,659 to 257,249 calls, out of `no-match` (142,754 → 48,227) and `dynamic` (84,889 → 9,826). The resolved share of the calls left, the ones that could reach workspace code, is 57.7% over the nine (92,503 of 160,339): `tanstack-query` 72.2%, `shadcn-ui` 69.8%, `zod` 64.9%, `nest` 64.2%, `zustand` 59.5%, `cal-com` 49.5%, `express` 45.4%, `trpc` 45.0%, `hono` 43.1%.

`CallCandidate` gains `unboundHead`, set where no scope around the call declares the target's leading name; the TypeScript plugin sets it, and now reads a namespace written without `export` and the names `declare global` declares as declarations of the module. `resolveCallGraph` takes `unboundHeads`, which the scan gathers from it.
