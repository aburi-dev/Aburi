---
"@aburi/core": minor
"@aburi/cli": minor
---

`aburi diff` stops the head scan when the base scan fails while both run at once, instead of waiting out the whole head scan in silence before it reports the base's error. The head stops at its next file, or before resolving its symbols and calls, so the run waits at most for the files the head is on. `scan()` and `runScan()` take an optional `signal: AbortSignal`, checked before each file and each phase after extraction; once it is aborted, the scan rejects with the signal's reason.
