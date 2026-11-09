---
"@aburi/cli": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Add `--quiet` to `aburi scan` and `aburi diff`, and `--filter` to `aburi diff`

`aburi scan --quiet` prints the two census lines alone, and `aburi diff --quiet` the glyph line alone; stderr, the files written and the exit code are unchanged.

`aburi diff --filter <statuses>` lists only the changes of the statuses named in `diff.md`, with a note under the Summary saying how many it left out. A Slice holding a kept change is drawn whole, and component changes, dependency changes and Not compared are listed in full, except a dependency change from test code whose caller the filter left out, which the note counts. `diff.json`, the glyph line and `--fail-on` still read every change, and when a tripped `--fail-on` clause counted changes the filter leaves out, stderr says how many and of which statuses. An empty value, an empty segment or a word that is no status exits 2. `runDiff` takes the filter as that string or as a list of statuses.

`projectDiff` takes the filter as its `statuses` option, and `@aburi/types` exports every `SymbolChange` status as the frozen `SYMBOL_CHANGE_STATUSES`, with its type `SymbolChangeStatus` and the guard `isSymbolChangeStatus`.
