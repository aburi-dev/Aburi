---
"@aburi/cli": minor
"@aburi/core": minor
"@aburi/plugin-registry": minor
---

`aburi vocab list | effects | extkinds | plugins | who-owns <value>` lists the vocabulary a scan holds the configured plugins to: the core effect ids, and every effect id, extKind, framework name and derivedBy prefix the plugins and `frameworkHints` entries declare, each with the plugin that owns it; `plugins` and `who-owns` also name the config entry that loaded each plugin. It loads and registers the plugins as `aburi scan` does, but scans nothing and calls no plugin's `init`, so it needs no language plugin. `who-owns` answers for each vocabulary a value is in, as the registry resolves it during a scan, and exits 1 when nothing owns it; `--json` writes one JSON object keyed as a manifest's `provides` is. `runVocab` drives it programmatically, and `loadPlugins` now reports the config entry each plugin came from as `listedIn`.

`@aburi/core` exports the core effect vocabulary with a description for each id as `CORE_EFFECTS`, its ids as the `CoreEffectId` union, and `isCoreEffectId` now narrows to it. `@aburi/plugin-registry` exports `isUnderPrefix`, the test a prefix declaration covers a value by, and refuses a manifest whose `version` is not a string, which used to register and print as `undefined`; `aburi scan` and `aburi vocab` exit 3 for it, naming the config entry.
