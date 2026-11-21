---
"@aburi/core": minor
---

Resolve a call into a workspace package imported by its name. `sortBy()` through `import { sortBy } from "@acme/kit"`, where `@acme/kit` is a workspace package no `tsconfig.json` path maps, now reaches the declaration at `high` confidence in the file the package's `package.json` names, through its re-exports, instead of being bucketed `external`. The scan reads `exports` for the subpath, the key written out or the `*` pattern with the longest prefix, and takes every target of that entry in the order the manifest writes them, across conditions and fallback lists, so a source condition such as `"source": "./src/index.ts"` reaches the source while one naming built output the checkout does not hold is passed over; without `exports`, it reads `main`, `module`, `types` and `typings`, then the package's directory. Each path is probed as a relative specifier's, so `"main": "./index.js"` reaches `index.ts`. An `"exports": null` falls back to `main` as Node does, and a name two workspace manifests share maps to neither, since nothing tells which one an import means. They follow the paths the language plugin maps the specifier to, which TypeScript reads first. A name the package does not export is bucketed `no-match`.

`WorkspacePackage` gains `entry`, the manifest's `exports`, `main`, `module`, `types` and `typings` as written, which `readWorkspacePackages` fills in, and `ExtractionJob` carries `workspacePackages` in place of `workspacePackageNames`.

On the pinned benchmark repositories, checked out without their dependencies installed: `zod` resolves 8,483 more calls (4,888 → 13,371), `cal-com` 7,365 (13,316 → 20,681), `tanstack-query` 5,000 (7,107 → 12,107) and `nest` 848 (5,802 → 6,650); the others name only built output or no workspace package.

A caller whose calls now resolve picks up its callees' effects as propagated effects, so its `logic` fingerprint moves with no change to its source. An `aburi diff` against an IR an earlier version wrote reports those callers as changed; one that scans both sides with this version does not.
