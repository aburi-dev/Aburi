---
"@aburi/lang-typescript": patch
---

The plugin loads tree-sitter and both its grammars in `init`, before any file's `parseTimeoutMs` budget starts. The load used to count against the first file of each grammar on every thread, so a pooled scan could skip, as `parse-timeout`, a file that a one-thread scan kept.
