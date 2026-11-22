---
"@aburi/core": minor
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

Bucket as `external` every unresolved call no declaration the scan read can be the callee of, not only one through a package import. That covers a global the runtime or a test runner provides (`setTimeout(…)`, `expect(x).toBe(1)`, `describe(…)`), where nothing around the call declares the leading name and no Symbol's qualified name starts with it, and a member that no Symbol is named and no module exports (`items.map(…)`, `this.emit(…)` in a class extending a package's `EventEmitter`). The check reads names, not declarations, so a member a workspace file assigns without declaring it as a Symbol counts too. `external` now comes right after `local-scope` in the bucket order, ahead of `dynamic` and `ambiguous`.

No call resolves differently; counts move between buckets. On the pinned benchmark repositories, checked out without their dependencies installed, authored `external` grows from 87,659 to 257,330 calls, out of `no-match` (142,754 → 48,182) and `dynamic` (84,889 → 9,790). The resolved share of the calls left, the ones that could reach workspace code, is 57.7% over the nine (92,503 of 160,258): `tanstack-query` 72.3%, `shadcn-ui` 69.8%, `zod` 65.0%, `nest` 64.2%, `zustand` 59.5%, `cal-com` 49.5%, `express` 45.6%, `trpc` 45.1%, `hono` 43.1%.

`CallCandidate` gains `unboundHead`, set where no scope around the call declares the target's leading name; the TypeScript plugin sets it. `resolveCallGraph` takes `unboundHeads`, which the scan gathers from it.
