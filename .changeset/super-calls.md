---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Resolve a call through `super` without LSP. In an instance member of `class AdminService extends BaseService`, a constructor's `super(…)` now reaches the class `BaseService` and `super.find()` the `find` it declares, or inherits from the nearest class up its chain that does, at `high` confidence, since `super` names one class and no subclass's override runs in its place. The class is bound in the caller's file, by its declarations and its imports, and a class a drop rule removed is walked through as a kept one is. A member read through `super` is on the prototype, so a `find` a field holds, one a drop rule removed and one that has no Symbol end the walk unresolved, and so do `super.repo.save()`, a static member, and an `extends` the resolver cannot bind, such as a mixin call.

The TypeScript plugin reports the name the class's `extends` writes as the call's `receiverType` on `super(…)` and `super.<member>`, so an effect plugin that classifies by the declared type reads it too: `super.emit(…)` in a class that extends `EventEmitter2` is an `event.publish` to `@aburi/effects-nest`. `FIELD_ASSIGNED_FUNCTION_DERIVED_BY` names the `derivedBy` tag of a member a field's function is.

On the pinned benchmark repositories this resolves 240 more calls on `nest` (10,696 → 10,936), 192 on `cal-com` (24,262 → 24,454), 90 on `tanstack-query` (15,374 → 15,464), 34 on `shadcn-ui`, 10 on `hono` and 5 on `trpc`, each the class or member the TypeScript checker reaches; most of what stays unresolved extends a built-in such as `Error`.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
