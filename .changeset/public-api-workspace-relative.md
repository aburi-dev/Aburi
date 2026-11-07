---
"@aburi/core": minor
"@aburi/cli": minor
---

A detected component's `publicApi` entries are now written from the workspace root, like `roots[]` and every Symbol id. `"exports": { ".": "./src/index.ts" }` in `packages/a/package.json` now gives `packages/a/src/index.ts` rather than `src/index.ts`. A diff against an IR scanned before this release reports each such component's `publicApi` as changed. A package at the workspace root keeps its entries as they were.

`aburi scan` now writes one line on stderr for each string `package.json` value that gives no entry: a directory, the package directory, an absolute path, a first segment that reads as a drive, a `..` segment, or a backslash. The line names the component, its manifest, the field and the value, in the order the manifest holds them. For example: `⚠ Component "demo": package.json#main is "./lib/", a directory rather than a file, so it gives no publicApi entry.` Only detected components get these lines; a component declared in `aburi.json`'s `components` has none. `aburi diff` writes the same lines for each of its scans, labelled with that scan (`⚠ base ref "main": Component …`).

`detectComponents` now returns `{ components, ignoredPublicApi }` in place of the `Component[]` it returned before. `@aburi/core` exports the new `DetectComponentsResult`, `IgnoredPublicApi` and `IgnoredPublicApiReason` types. `ScanReport` gains the required `ignoredPublicApi`, so a caller that builds a `ScanReport` itself has to supply it.
