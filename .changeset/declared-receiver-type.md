---
"@aburi/core": minor
---

Resolve a call through a field of a declared type without LSP. `this.repo.find(id)` beside `constructor(private readonly repo: UserRepository)` now reaches `UserRepository.find`, at `medium` confidence because the value can be a subclass's, where it used to stay unresolved in the `dynamic` bucket. The type is read from the language plugin's `receiverType` and bound as the file's own names are, by its declarations and its imports, a `tsconfig.json` path alias included; it must name a class that declares the member itself, as an instance member. An interface-typed, unannotated, union-typed or inherited field still resolves nothing, as does a class reached only through a barrel or a package name, and so do the calls on one line of one Symbol when they do not all name one type. The rule is the untyped tier's last, so it resolves alike with LSP on or off, and a language server's hint is read only for a call it leaves unresolved.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source: in the NestJS showcase example each controller method gains its service's `db.read` or `db.write`. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.

On the pinned benchmark repositories this resolves 904 more calls on `cal-com` (11,802 → 12,706), 373 on `nest` (3,301 → 3,674), 55 on `tanstack-query`, 13 on `trpc` and 5 on `hono`, each leaving the `dynamic` bucket; the others are unchanged. `resolveCallGraph` takes the types as `declaredReceiverTypes`, keyed by `makeSymbolCallKey(symbol, line, target)`, which `@aburi/core` now exports with the `DeclaredReceiverTypes` type.
