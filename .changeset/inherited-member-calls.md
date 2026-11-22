---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Resolve a call of a member a class inherits without LSP. Through a receiver whose class the source names, `this.load()` in `class UserService extends Base`, `repo.find()` beside `repo: AdminRepository` where `AdminRepository extends Repository`, and `this.repo.find()` beside a field of that type, the resolver now walks the classes the receiver's class extends to the nearest one that declares the member, and reaches `Base.load` or `Repository.find` at `medium` confidence, where the call used to stay unresolved. Each class's `extends` is bound in the file that declares that class, by its declarations and its imports, and a class a drop rule removed, such as a subclass that only adds fields, is walked through as a kept one is. A member the class declares itself ends the walk unresolved, since it is the one that runs: a method a drop rule removed, and one that has no Symbol, a field holding data (`find = make()`), a parameter property or a name its code assigns to `this`. A field written only with its type, as a subclass narrows the type of a member it inherits (`subscribe!: Narrowed`), is none, and the walk goes past it. So do an `extends` that binds no class the resolver can see, a mixin call (`extends Mixin(Base)`) and classes that extend one another in a cycle.

`SymbolCandidate` gains `superclass`, the name a class's `extends` writes, type arguments aside, which the TypeScript plugin reports when no scope but the module binds that name, and beside it `instanceMembers`, every instance member the class declares, a Symbol or not, a field written only with its type aside. `resolveCallGraph` takes them as `classHeritages`, keyed by the class's Symbol id, and the scan passes them.

On the pinned benchmark repositories this resolves 520 more calls on `nest` (10,176 → 10,696), 407 on `tanstack-query` (14,967 → 15,374), 212 on `cal-com` (24,036 → 24,248), 84 on `zod` and 3 on `hono`.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
