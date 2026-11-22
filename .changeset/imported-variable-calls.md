---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Resolve a call through a variable another module declares. `onlineManager.setOnline(true)` through `import { onlineManager } from "./onlineManager"`, where that module writes `export const onlineManager = new OnlineManager()` or `export let onlineManager: OnlineManager | null`, now reaches `OnlineManager.setOnline`, or the member a class it extends declares, at `medium` confidence, where the call used to stay unresolved. The variable is reached as an imported name is, under an alias, through a namespace import or a barrel, and its type is bound in the module that declares it, by its declarations and its imports. A name the caller's file declares, and a parameter of the caller's, keep the type the call itself carries.

`SymbolCandidate` gains `valueType`, which the TypeScript plugin reports for a variable of a module or a namespace that is annotated with a named type or is a `const` constructed from a class, read as it reads the declaration of a name a call goes through. `resolveCallGraph` takes them as `valueTypes`, keyed by the variable's Symbol id, and the scan passes them.

On the pinned benchmark repositories this resolves 381 more calls on `trpc` (3,108 → 3,489), most of them `initTRPC.create()`, 61 on `tanstack-query` (15,464 → 15,525), 57 on `nest` (10,936 → 10,993), 44 on `cal-com` (24,454 → 24,498) and 19 on `zod`, each the member the TypeScript checker reaches wherever it resolves the import.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
