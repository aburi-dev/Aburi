---
"@aburi/core": minor
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

Resolve a call through what another call gives back. `getRepo().save()`, `builder.with(1).save()` and `repo.save()` beside `const repo = getRepo()` now reach `UserRepository.save` at `medium` confidence where `getRepo` says what it gives back: a return annotation (`: UserRepository`, `: this`), a body whose every `return` gives back `this`, a `new` or a name declared with a type, a body that returns one call whose callee says so, or a `const` holding such a function by name (`export const create = UserRepository.create`). The type is bound in the file that declares the callee. `new UserRepository().save()` resolves too, and so does a class's own name constructed in its body (`static create() { return new UserRepository() }`).

`SymbolCandidate` gains `returns`, what a call of the Symbol gives back, and `CallCandidate` gains `receiverCall`, the call whose result the receiver is; the TypeScript plugin sets both. `resolveCallGraph` takes `returnSources` and `receiverCalls`, which the scan gathers from them.

On the pinned benchmark repositories, checked out without their dependencies installed: `zod` resolves 1,748 more calls (15,421 → 17,169), `tanstack-query` 457 (15,531 → 15,988), `nest` 416 (11,133 → 11,549), `cal-com` 223, `trpc` 97 and `hono` 82; `zustand`, `express` and `shadcn-ui` are unchanged.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
