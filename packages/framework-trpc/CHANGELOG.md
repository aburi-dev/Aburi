# @aburi/framework-trpc

## 0.3.0

### Minor Changes

- ea002cd: Link a procedure to what it is built on. A procedure or base procedure now calls the base procedure its chain starts from and each middleware a `.use(…)` or `.concat(…)` on its chain is handed by name or member path, so `deletePost = protectedProcedure.use(isAdmin).mutation(…)` resolves to `protectedProcedure` and `isAdmin`. An effect either one performs, such as a session read in the base procedure's middleware, is a propagated effect of the procedure, and `aburi explain` on the base procedure lists the procedures built on it under Called by. A factory call (`requireRole("admin")`, or `createProcedure("read")` at the start of the chain) was a call already, and an inline middleware, a spread and a computed member add none. Nor does a middleware composed inside the `.use(…)` (`use(isAuthed.unstable_pipe(isAdmin))`): its only call is `isAuthed.unstable_pipe`, which resolves to nothing, so the effects of `isAuthed` and `isAdmin` do not reach the procedure.
  
  On the pinned benchmark repositories this adds 3 calls on `trpc`, all resolved to base procedures, and 20 on `cal-com`, 18 of them resolved (11 to base procedures, 5 to middleware, 2 to middleware built with `unstable_pipe`, which the plugin does not classify); the two left unresolved name base procedures imported through a workspace package name. No fingerprint moves on either, since none of those base procedures or middleware performs an effect the scan classifies.
  
  A procedure that inherits an effect this way has a new `logic` fingerprint with no change to its source, so an `aburi diff` against an IR an earlier version wrote reports it as changed; one that scans both sides with this version does not. A guard removed from a base procedure is still a change to the base procedure alone: rules do not propagate.
- b56e5d9: Name the middleware a tRPC procedure or base procedure runs: the base procedure its chain starts from, what each `.use(…)` on its own chain is handed and the builder each `.concat(…)` joins, in the order they run. Removing `.use(isAuthed)` from a procedure declared as a `const`, or building that procedure on `publicProcedure` instead of `protectedProcedure`, is now a logic change the report names (`middleware removed: isAuthed`) rather than a reformat, and swapping two is one with `reordered: true`. A procedure or base procedure that names any, every procedure built on a named base procedure among them, now carries `middleware`, so compared against an IR from an earlier version its logic fingerprint moves. `@aburi/core` exports the naming framework-express used as `middlewareNames`, and both plugins name middleware through it.

### Patch Changes

- 6e1e180: Declare `engines.node` as `>=24`, the Node.js version the documentation already requires, so a package manager can say so on an older Node instead of the package failing at run time.
- e794d20: Document that a procedure written inside a router's object literal, still no Symbol of its own, is walked as part of the router: its resolver's calls, rules and effects are the router's.
- Updated dependencies: `@aburi/core@0.9.0`, `@aburi/types@0.9.0`

## 0.2.1

### Patch Changes

- Updated dependencies: `@aburi/core@0.8.0`, `@aburi/types@0.8.0`

## 0.2.0

### Minor Changes

- 3b3d306: Move the documentation site and the JSON Schemas to `aburi.dev`
  
  The four schemas now identify themselves as `https://aburi.dev/schema/...`, and that is the `$schema` an IR, a diff, an `aburi init` config and every bundled plugin manifest carries. The site, including the schemas under `/schema/`, is served from `https://aburi.dev`.
  
  Nothing written before has to change. Each schema's `$schema` now accepts the `aburi.kage1020.com` URL it carried until now beside the `aburi.dev` one, so an existing `aburi.json`, a plugin manifest naming the former host, and a committed IR all stay valid v1: `aburi diff` and `aburi explain` read such an IR, and a base and head that differ only in which host they name are diffed as one schema version. The former host keeps answering, so an editor resolving an old `$schema` line still finds the schema.
  
  `@aburi/types` exports the URLs Aburi writes — `IR_SCHEMA_URL`, `DIFF_SCHEMA_URL`, `CONFIG_SCHEMA_URL`, `PLUGIN_SCHEMA_URL` — and `isIRSchemaURL`, which accepts every `$schema` the IR schema does. The generated `$schema` types widen to the two values each schema accepts.
  
  An earlier `@aburi/cli` accepts only the former host, so it refuses everything this release writes: the `aburi.json` that `aburi init` writes (or one whose `$schema` line follows the docs) fails with `config-invalid` at exit 2, an IR from `aburi scan` is refused by `aburi diff <files>` and `aburi explain`, and a plugin from this release fails to load. Upgrade the CLI first — including a GitHub Action `version:` pinned to an earlier one — and then the configs and plugins.

### Patch Changes

- Updated dependencies: `@aburi/core@0.7.0`, `@aburi/types@0.7.0`

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
