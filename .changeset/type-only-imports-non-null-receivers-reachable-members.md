---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Reach no value through a type-only import, resolve a call through a non-null assertion, and count a member a module keeps to itself only where its values can be.

- `ImportEdge.typeOnlyLocals` names the locals an import binds as a type alone, and `@aburi/lang-typescript` sets it for `import type { X }`, `import { type X }`, `import type D, { E }`, `import type * as ns` and `import type x = require()`. A call through such a name no longer resolves to the declaration the import names, nor to a namesake elsewhere: it stays `null`, bucketed `no-match`, and the caller takes none of its effects. A declared type the import binds (`repo: Repo` below `import type { Repo }`) still resolves `repo.save()`, and a value import beside it (`import { type X, make }`) still binds `make`. The edge is otherwise unchanged, so Component edges and the effect plugins that gate on a file's imports read it as before.
- The call resolver reads a target without the non-null assertions written after its segments, in every scope, so `helper!()`, `svc!.save()`, `ns!.helper!()` and `Repo!.save()` resolve as they would without the `!`. The IR's `target` keeps it. `@aburi/lang-typescript` reads a receiver through the assertion too: `this.events!.emit()` beside `events?: EventEmitter2` carries `receiverType`, `managers!.manager!.stop()` through an import carries `importedReceiver`, and `make()!.run()` and `s!.run()` carry `receiverCall`.
- A qualified call whose member is named only by declarations a module keeps to itself is now `external` in a module that cannot be handed a value of them. A member of a top-level declaration its module does not export, and a non-exported top-level name, count toward the reachable calls only in that module and in modules whose imports reach it, directly or through re-exports. One private `push` or `join` used to keep every unresolved `items.push()` and `parts.join()` of the workspace out of `external`. A member of an exported declaration still counts everywhere, so the estimate still errs both ways, as the census docs now say.

On the pinned `nest` checkout 9 more calls resolve, all through `!` (`this.socket!.on()`, `wrapper!.getInstanceByContextId()`), with no fingerprint moving. On `cal-com` resolution does not change, and external goes from 66013 to 66255 (dynamic 1364 to 1289, no-match 3855 to 3688), so the reachable rate moves from 42.0% to 42.2%. On this repository 531 calls move to `external`, and the reachable rate moves from 67.7% to 69.0%. `hono` moves 4 calls.
