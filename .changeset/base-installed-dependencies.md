---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": patch
"@aburi/cli": patch
---

`aburi diff <base>..<head>` now reads a `tsconfig` package's path aliases on the base side as it does on the head side. The base is checked out without `node_modules`, so an `extends` entry naming a package, such as `@repo/tsconfig/base.json`, found no config there, and every decorator imported through one of its aliases from a barrel re-exporting `@nestjs/common` read as `confidence: medium → high` although nobody changed it.

The base scan now passes the head's workspace root as `installedRoot`, a new optional field of `ScanInput` and of `ImportResolverContext`. The TypeScript resolver looks a package the base lacks up in the head's `node_modules`. A workspace package the head's install links there is read from the base's own copy, so the base's revision of the shared config applies; a package installed from a registry is read as the head has it installed.

A package entry in `extends` is also read where its links lead, as `tsc` reads it, on either side: the relative `paths` of a linked workspace package's config resolve among that package's sources rather than under `node_modules`, and a broken one is warned about once, by the name of its sources. A relative entry is read where it is written, as `tsc` reads it, so one through `node_modules` resolves its relative values there on both sides alike. The workspace root and the installed root are compared as their links lead, so a root reached through a symlink, a junction or a temporary directory that is itself a link reads the same and names a config in a warning by its path in the checkout. A config whose links cannot be followed for another reason than its absence is read where it is written, with a warning saying so.
