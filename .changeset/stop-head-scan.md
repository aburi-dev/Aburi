---
"@aburi/core": minor
"@aburi/cli": minor
---

`aburi diff` stops the head scan when the base scan fails while both run at once, instead of waiting out the whole head scan in silence before it reports the base's error. The head stops at its next file while it extracts or enriches through LSP, and otherwise at its next phase boundary up to resolving its calls; a head already past that finishes and writes its IR first. `scan()` takes an optional `signal: AbortSignal`, checked before each file it extracts or enriches and before each phase up to call resolution, and rejects with the signal's reason once it is aborted. `runScan()` takes the same option, checks it before it loads the config, and hands it to `scan()`.
