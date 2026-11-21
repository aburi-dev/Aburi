---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/cli": patch
---

The IR records the grammar each language plugin parses with, in place of `pending@0.0.0`. A lang manifest declares it as `grammarRevision: "<grammar-package>@<MAJOR.MINOR.PATCH>"`, which the manifest schema, the registry and `scan()` hold to that form. A lang manifest that declares none is recorded as `<name>@<version>`, without build metadata. `@aburi/lang-typescript` declares `@vscode/tree-sitter-wasm@<version>`, the package its build copies the `.wasm` grammars from. `@aburi/types` exports `GRAMMAR_REVISION_PATTERN`. A lang manifest's `version` then stands for its grammar, which holds only while it changes with every grammar change, and `scan()` refuses a plugin whose fallback would be off the form. When `aburi diff --base <ir> --head <ir>` finds a plugin recording another grammar revision on each side, its plugin-set warning now adds that every Symbol parsed by that plugin can read as a syntax-only change under the other grammar.

An IR saved by an earlier release records `pending@0.0.0`, so the first `--base <ir> --head <ir>` diff of it against a new one shows that warning. Rescan the stored side, such as a base IR a CI caches, to compare like with like.
