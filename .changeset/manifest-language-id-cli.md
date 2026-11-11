---
"@aburi/cli": minor
---

`aburi scan` exits 3 before extraction, naming the config entry that loaded the plugin, for a language plugin whose manifest declares no `languageId`, one outside `[a-z][a-z0-9]*`, the reserved `slice`, or a token another configured plugin declared. A language plugin that sets `languageId` on the plugin object, and not in its manifest, has to move it there.
