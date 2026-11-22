---
"@aburi/lang-typescript": minor
---

Read the type of a `readonly` field from the class it is constructed from. `this.repo.find()` beside `private readonly repo = new UserRepository()` now carries `UserRepository` as its `receiverType`, as a `const` constructed from the class does, so the call resolves to `UserRepository.find` and an effect plugin that classifies by the declared type reads it: `this.events.emit(…)` beside `private readonly events = new EventEmitter2()` is an `event.publish` to `@aburi/effects-nest`. A `readonly` field is assigned again only in its constructor, with a value of the type its initializer gives it. A field that is not `readonly` reads no type from its initializer, as a `let` does not.

On the pinned benchmark repositories this resolves 140 more calls on `nest` (10,993 → 11,133), half of them through a `Logger` a class constructs for itself, 6 on `tanstack-query` and 2 on `cal-com`.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
