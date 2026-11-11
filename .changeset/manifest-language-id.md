---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/diff": patch
---

A language plugin's `LanguageId` is now its manifest's `languageId`, not a field of the plugin object: `LanguagePlugin.languageId` is removed, and `LangManifest` carries `languageId`. The plugin manifest schema adds it as an optional field that only a `lang` manifest may hold, and `VocabRegistry.register` requires it of every `lang` manifest. The registry refuses a token outside `[a-z][a-z0-9]*`, the reserved `slice`, and a token another registered plugin already declared (`duplicate-id`, naming both). The core refuses, with `scan-plugin-misconfigured`, a language plugin handed to `scan` whose manifest carries no string `languageId` (before any file is parsed) and a Symbol id whose prefix is not the minting plugin's `languageId`. `EffectsManifest` and `FrameworkManifest` no longer admit a `languageId`. `LANGUAGE_ID_PATTERN` and `RESERVED_LANGUAGE_IDS` move to `@aburi/types`, beside `LANGUAGE_ID_GRAMMAR`, the unanchored grammar, and `@aburi/core` no longer exports `RESERVED_LANGUAGE_IDS`.
