---
"@aburi/plugin-process": minor
---

Add `onStart`, run on each process the helper starts before any other request reaches it, and `start()`, which starts the process and resolves once `onStart` has finished. A parser that has to be told something first, such as an `initialize`, is now told it again when the helper replaces it after a crash, so the files after the one that killed it are parsed rather than refused. A failed `onStart` rejects with `start-failed` and counts toward `abandoned`.
