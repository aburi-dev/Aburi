---
"@aburi/core": minor
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

Resolve a call through a barrel's re-exports. `format()` through `import { format } from "./lib"`, where `lib/index.ts` writes `export * from "./format"`, `export { total as format } from "./math"`, `import { format } from "./format"` with `export { format }`, or `export { default as format } from "./format"`, now reaches the declaration at `high` confidence, through any chain of barrels and relative or `tsconfig.json`-mapped specifiers, and so does an alias, a default or a namespace import of the barrel, and `ns.f()` through `export * as ns from`. A name two `export *` disagree on is bucketed `ambiguous` with both declarations, and a chain that leaves the workspace through a package's specifier is bucketed `external`. `export type *` and type-only re-exports lead nowhere. A field typed with a class a barrel re-exports resolves its calls the same way.

`ImportEdge` gains `reexportsAll`, which the TypeScript plugin sets on the edge of a value `export * from`. `resolveCallGraph` takes `moduleFiles`, every file the scan read by language, so a specifier that names a barrel holding no Symbol reaches it; the scan passes them, and maps the bare specifiers of a file that re-exports as it maps those of a file that calls.

On the pinned benchmark repositories, checked out without their dependencies installed: `nest` resolves 2,094 more calls (3,708 → 5,802), `tanstack-query` 2,233 (4,874 → 7,107), `zod` 1,179 (3,709 → 4,888), `trpc` 841 (2,225 → 3,066), `hono` 655 (4,371 → 5,026), `zustand` 449 (342 → 791), `cal-com` 207 and `shadcn-ui` 87; `express` is unchanged.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
