---
"@aburi/core": minor
"@aburi/cli": minor
---

A scan now names each Component whose files are in a language no loaded plugin reads: `Component "ml" has files no loaded language plugin reads (10 py): none was scanned, and none counts in the IR's stats.` Such files are not counted in `stats.totalFiles` or `stats.skippedFiles`, so in a mixed repository a Python package used to contribute nothing with nothing said. The line names only a language in the Component's `languages`, and counts the files that Component owns that `.gitignore` and `ignore` leave in. `ScanResult` gains `unreadLanguages` and `DiscoverResult` gains `unclaimedFiles`.
