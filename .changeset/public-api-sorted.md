---
"@aburi/core": patch
---

A Component's `publicApi` is written sorted by code unit, each entry once, whichever source gave it, so reordering the list in `aburi.json` or naming an entry twice no longer shows up as a Component change. The integrity check now holds `publicApi[]` to that order, so an IR an earlier release wrote from a config whose list was out of order is refused on read; scan again to replace it.
