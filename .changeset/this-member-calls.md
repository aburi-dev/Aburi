---
"@aburi/lang-typescript": minor
"@aburi/core": minor
---

Resolve `this.find()` to the member its class declares without LSP. In an instance member of `class UserService`, its methods, accessors, constructor and fields' arrows, through arrows, the TypeScript plugin now reports the class's own name as the call's `receiverType`, and the resolver reaches `UserService.find`, a method or a field's function, at `medium` confidence because the value can be a subclass's, where the call used to stay unresolved in the `dynamic` bucket. A static member, a class expression or an anonymous class, a class a function or a namespace declares, an object literal's method and a `function`, which binds its own `this`, carry no type, and a member the class only inherits still resolves nothing. With a language server running, its hint for a `this.<method>` call is read first, since it reads what the class inherits too, at `high` confidence where the class declares the member; the class's own member answers what the hint leaves.

On the pinned benchmark repositories this resolves 1,480 more calls on `cal-com` (20,681 → 22,161), 1,024 on `nest` (6,650 → 7,674), 353 on `tanstack-query`, 75 on `zod`, 62 on `hono`, 26 on `trpc` and 1 on `shadcn-ui`, each leaving the `dynamic` bucket.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
