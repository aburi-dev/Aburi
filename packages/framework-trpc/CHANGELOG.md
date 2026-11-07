# @aburi/framework-trpc

## 0.1.0

### Minor Changes

- bb90fea: New package `@aburi/framework-trpc` classifies the server side of tRPC as Boundaries: the `initTRPC` instance (`framework:trpc:instance`), routers and merged routers (`framework:trpc:router`), `query` / `mutation` / `subscription` procedures (`framework:trpc:procedure`), base procedures such as `t.procedure.use(isAuthed)` (`framework:trpc:base-procedure`) and middleware (`framework:trpc:middleware`), each a `const` whose own declarator holds the shape. A procedure's resolver is a function, an async generator, a name for one, or a call that returns one, and the bare `t.procedure` is a base procedure only off a plain name in a file that imports `@trpc/server`. Confidence is `high` in a file that imports `@trpc/server` and `medium` elsewhere. `aburi init` now writes `framework-trpc` for a workspace that depends on `@trpc/server`, where it used to report the framework as unmapped. The `@aburi/effects-trpc` README names the new package as the one that covers server-side routers.

  `@aburi/core` exports `receiverChain`, the receiver walk `calleeName` names a call by, with each property and method on the way, and `writtenChildren`, a node's named children without comments. `@aburi/framework-express` reads its arguments through the latter.

### Patch Changes

- Updated dependencies [19ead65]
- Updated dependencies [af4b970]
- Updated dependencies [c6ce311]
- Updated dependencies [b7a7148]
- Updated dependencies [f2a6916]
- Updated dependencies [50ea5bb]
- Updated dependencies [90fa1cb]
- Updated dependencies [b7a7148]
- Updated dependencies [9c21737]
- Updated dependencies [dde9172]
- Updated dependencies [7d4dbf9]
- Updated dependencies [3b52db9]
- Updated dependencies [dfffac9]
- Updated dependencies [ad04fff]
- Updated dependencies [13f8ba9]
- Updated dependencies [1a56ce7]
- Updated dependencies [107c1c6]
- Updated dependencies [b2155c1]
- Updated dependencies [b2155c1]
- Updated dependencies [bb90fea]
- Updated dependencies [f32e45b]
- Updated dependencies [b7a7148]
- Updated dependencies [80be216]
- Updated dependencies [50c0bd2]
- Updated dependencies [a6cd1ac]
- Updated dependencies [f9d300c]
- Updated dependencies [1a41bef]
- Updated dependencies [6be7d2e]
- Updated dependencies [ad21560]
- Updated dependencies [517eb21]
- Updated dependencies [36fd72f]
- Updated dependencies [6afef8b]
- Updated dependencies [eb4ab00]
- Updated dependencies [d4fca12]
- Updated dependencies [635be83]
- Updated dependencies [659f00c]
- Updated dependencies [7830c96]
- Updated dependencies [463d616]
- Updated dependencies [7830c96]
- Updated dependencies [47f8ef9]
- Updated dependencies [65c758f]
  - @aburi/core@0.6.0
  - @aburi/types@0.6.0
