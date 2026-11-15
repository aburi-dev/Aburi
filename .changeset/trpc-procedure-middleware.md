---
"@aburi/core": minor
"@aburi/framework-trpc": minor
"@aburi/framework-express": patch
---

Name the middleware a tRPC procedure or base procedure runs: the base procedure its chain starts from, what each `.use(…)` on its own chain is handed and the builder each `.concat(…)` joins, in the order they run. Removing `.use(isAuthed)` from a procedure declared as a `const`, or building that procedure on `publicProcedure` instead of `protectedProcedure`, is now a logic change the report names (`middleware removed: isAuthed`) rather than a reformat, and swapping two is one with `reordered: true`. A procedure or base procedure that names any, every procedure built on a named base procedure among them, now carries `middleware`, so compared against an IR from an earlier version its logic fingerprint moves. `@aburi/core` exports the naming framework-express used as `middlewareNames`, and both plugins name middleware through it.
