---
"@aburi/lang-typescript": minor
---

Resolve `repo.find()` through the class `repo` is declared or constructed with. The TypeScript plugin now reports a `receiverType` for a call through a plain name, read off the declaration the nearest scope around the call gives the name: a parameter's annotation (`repo: UserRepository`, `repo?: UserRepository`), a variable's (`const repo: UserRepository = make()`, `let repo: UserRepository | null`, `declare const repo: UserRepository`), or the class a `const` is constructed from (`const repo = new UserRepository()`), in the module or in a function around the call. The resolver reaches `UserRepository.find` at `medium` confidence, as it does for `this.repo.find()`, where the call used to stay unresolved. A declaration with no annotation or with a union of two types, a destructured or rest parameter, a `let` or `var` constructed from a class, an import, a `for…of`, `catch`, `using` or `await using` binding, and a name its scope declares twice carry no type, and a name a nested scope declares again without a type hides the outer declaration's. A type that may be `null` or `undefined` (`UserRepository | null`) now counts as the type, for a field of `this` too.

On the pinned benchmark repositories this resolves 2,507 more calls on `tanstack-query` (12,460 → 14,967), 2,502 on `nest` (7,674 → 10,176), 1,875 on `cal-com` (22,161 → 24,036), 568 on `hono`, 266 on `zod` and 11 on `trpc`.

`@aburi/effects-nest` reads the same field, so `bus.emit(…)` beside a parameter `bus: EventEmitter2`, or `const bus = new EventEmitter2()`, is now an `event.publish` where it used to stay a call.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
