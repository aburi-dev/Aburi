---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Leave a call through a local to the local, end the search at a package outside the workspace, and read path aliases wherever a scan reads a file's imports.

- A call whose leading name a local declares no longer links to a declaration of that name in the module or behind an import. That covers a nested function, a `const`, a block's binding, a callback's parameter and a `catch` binding. `CallCandidate.localHead` marks such a call, and `@aburi/lang-typescript` sets it. The resolver treats a marked call as it treats a call through a parameter: `resolved` stays `null`, bucketed `local-scope`, and the caller takes none of the namesake's effects. A type the local is declared with still resolves the call.
- A qualified call through a named import of a package outside the workspace ends the search there, bucketed `external`. `Logger.log()` through `import { Logger } from "@nestjs/common"` no longer reaches a workspace class `Logger` with a `log`, nor its effects. Component and workspace scope are still searched through a workspace package's name that maps to no file the scan read, as when its manifest names only built output. `resolveCallGraph` takes the names as `workspacePackageNames`.
- A file's bare specifiers are mapped through the language's import resolver whenever something reads the answer. Before, that happened only for a file that made a call or re-exported. Now it also happens for a file declaring a class's `extends`, a variable's type or a function's return type, and for a file in a Component. So a subclass, an annotated `let` or a typed function in a file that makes no call binds its type through a path alias.
- An import through a path alias, or a path under `baseUrl`, that maps to a file the scan read draws a `via: "import"` Component edge to the Component holding that file, as a relative import of it does. In an nx workspace, projects import each other only through such aliases, so the Component graph now has their edges.

On the pinned `cal-com` checkout, 20 calls stop resolving. 18 of them linked to a namesake the local hides, the caller itself among them. The unresolved buckets move from local-scope 5211, external 77556, no-match 17641 to local-scope 29251, external 66605, no-match 4992, since a call through a local now buckets as one through a parameter does. No fingerprint moves.
