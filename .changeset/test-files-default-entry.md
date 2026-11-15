---
"@aburi/core": minor
"@aburi/types": patch
---

An entry `"..."` in `testFiles` stands for the default list, so `["...", "examples/**"]` adds one pattern to it instead of replacing it. A config that copied the default to add a pattern can write this instead, and keeps up when a release adds a default pattern, which the copy would not. A `!` pattern takes files out of the combined list, and a list without `"..."` still replaces the default.
