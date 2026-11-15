---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/cli": patch
---

The IR records the grammar each language plugin parses with, in place of `pending@0.0.0`. A lang manifest declares it as `grammarRevision: "<grammar-package>@<MAJOR.MINOR.PATCH>"`, which the manifest schema, the registry and `scan()` hold to that form. A lang manifest that declares none is recorded as `<name>@<version>`, without build metadata. `@aburi/lang-typescript` declares `@vscode/tree-sitter-wasm@<version>`, the package its build copies the `.wasm` grammars from. `@aburi/types` exports `GRAMMAR_REVISION_PATTERN`. When `aburi diff --base <ir> --head <ir>` finds a plugin's grammar revision differs between the two IRs, its plugin-set warning now adds that every Symbol of that language can read as a syntax-only change.
