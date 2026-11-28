---
"@aburi/diff": patch
---

A removed Symbol from authored code is no longer called a duplicate of a byte-identical Symbol that survives only in a test file or a generated file: `roundCents` deleted from `src/money.ts` while `test/money.test.ts` keeps its own copy now carries `duplicateOf: null`, so `--fail-on removed` counts it again. A removal from a test or generated file still names a survivor in authored code or in a file of its own kind, and authored code deleted beside an authored copy and a test copy names the authored one.
