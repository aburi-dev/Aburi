---
"@aburi/core": minor
"@aburi/cli": minor
---

Call every plugin's `init(ctx)` before the scan's first file and its `cleanup()` after the last plugin call, newest first, as the plugin contract has always described. An `init` that throws ends the scan with the plugin-set fault `plugin-init-failed`, so `aburi scan` exits `3` naming the plugin; a `cleanup` that throws is a warning. A plugin without either still loads; one that sets either to something other than a function is refused as `scan-plugin-misconfigured` before any `init` runs, and an object listed more than once is initialized and cleaned up once. A scan extracting on parser workers initializes and cleans up the plugins each worker loaded, on that worker, says what they log doing so once, and ends as one thread does when an `init` fails.
