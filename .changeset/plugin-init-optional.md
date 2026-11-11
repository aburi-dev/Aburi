---
"@aburi/types": minor
---

Make `init(ctx)` optional on language, framework and effects plugins, as `cleanup()` already was: a plugin with nothing to open before the scan leaves it out.
