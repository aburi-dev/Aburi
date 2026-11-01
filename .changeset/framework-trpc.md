---
"@aburi/framework-trpc": minor
"@aburi/cli": minor
"@aburi/effects-trpc": patch
"@aburi/core": minor
"@aburi/framework-express": patch
---

New package `@aburi/framework-trpc` classifies the server side of tRPC as Boundaries: the `initTRPC` instance (`framework:trpc:instance`), routers and merged routers (`framework:trpc:router`), `query` / `mutation` / `subscription` procedures (`framework:trpc:procedure`), base procedures such as `t.procedure.use(isAuthed)` (`framework:trpc:base-procedure`) and middleware (`framework:trpc:middleware`), each a `const` whose own declarator holds the shape. A procedure's resolver is a function, an async generator, a name for one, or a call that returns one, and the bare `t.procedure` is a base procedure only off a plain name in a file that imports `@trpc/server`. Confidence is `high` in a file that imports `@trpc/server` and `medium` elsewhere. `aburi init` now writes `framework-trpc` for a workspace that depends on `@trpc/server`, where it used to report the framework as unmapped. The `@aburi/effects-trpc` README names the new package as the one that covers server-side routers.

`@aburi/core` exports `receiverChain`, the receiver walk `calleeName` names a call by, with each property and method on the way, and `writtenChildren`, a node's named children without comments. `@aburi/framework-express` reads its arguments through the latter.
