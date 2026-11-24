---
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/framework-express": patch
"@aburi/framework-trpc": patch
---

Read a CommonJS `require("…")` as an import. The TypeScript plugin now records an import edge for every call of `require` with one static specifier, unless a function binds that `require` itself, so the effect and framework plugins that gate on a file's imports classify a `.js` or `.cjs` file as they classify an ESM one: `prisma.user.create()` below `const { PrismaClient } = require("@prisma/client")` is a `db.write`, a tRPC server reached through `require("@trpc/server")` is classified at `high`, and the workspace report draws a Component dependency for the module.

At the top of a file, `const m = require("./m")`, `const { a, b: c } = require("./m")` and `const R = require("./m").Router`, exported or not, also bind their names, as `import m = require("./m")`, `import { a, b as c }` and `import { Router as R }` would, and call resolution reads such a declaration through its import first: `createUser()` below `const { createUser } = require("./users")` now reaches the function `users.js` declares, and takes its effects, where it used to stop at the `const`. A member the import does not find is still looked for in the rest of the workspace, as before, and a name the import binds from a package outside it still resolves to the `const`. A `require()` anywhere else records only that the file loads the module.

On the pinned `express` benchmark repository this resolves 52 more calls (2,133 → 2,185) and moves 4 from the local `const` to the function it names; `cal-com` gains 18 Prisma effects in its CommonJS scripts.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
