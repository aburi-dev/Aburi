---
"@aburi/cli": patch
---

`aburi explain` now marks the line it prints when it answers from an IR above the working directory with `⚠`, like every other warning, so a `grep '⚠'` over a CI log finds it.
