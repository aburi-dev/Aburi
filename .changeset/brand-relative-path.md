---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/diff": patch
"@aburi/cli": patch
---

Brand `RelativePath`, so a path nothing checked cannot be written into the IR

`RelativePath` — the type of `symbols[].source.file`, `components[].roots[]` and `workspace.managers[].roots[]` — is now a branded string like `SymbolId` and `ComponentId`: it still reads as a `string`, but a bare `string` no longer satisfies it. `SourceFile.path`, the path a language plugin is handed, carries the brand, so a plugin that writes `ctx.file.path` back as `source.file` needs no change. `toDocumentPath` from `@aburi/core` is the only other way to mint one, and now takes an optional subject to name the value in its refusal.

A language plugin whose candidate carries a `source.file` the path grammar refuses — a backslash, a `..` segment, an absolute path — now withdraws that file, recorded under `extractionFailures` with code `non-posix-path` and a message naming the plugin, instead of failing the whole scan at the integrity check once every file was extracted. The file keeps its recoverable parse errors, as a file withdrawn for a duplicate Symbol id does.

In `@aburi/core`, `DiscoveredFile.path` and `WorkspaceCandidate.relativeRoot` are `RelativePath`. In `@aburi/diff`, the lost-file and rename maps are keyed by `string`, as `stats.skippedFiles[].path` and `GitRenameMap` are.
