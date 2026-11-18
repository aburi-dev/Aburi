---
"@aburi/core": minor
"@aburi/config": patch
"@aburi/types": patch
---

An entry `"..."` in `testFiles` stands for the default list, so `["...", "examples/**"]` adds one pattern to it instead of replacing it. A config that copied the default to add a pattern can write this instead, and keeps up when a release adds a default pattern, which the copy would not. A `!` pattern takes files out of the combined list, so `["...", "!src/test"]` keeps a production `src/test/` out of the default, and a list without `"..."` still replaces it. `"!..."` is rejected as `config-invalid`, since as a `!` pattern it would take nothing out.
