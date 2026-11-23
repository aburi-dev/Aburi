---
"@aburi/core": minor
---

Keep an abstract method and a function or method declared under `declare` instead of dropping it as `empty body`, so a change to the signature it declares is reported under API changes. Neither may be written with a body: the signature is all it declares, and it is what a subclass or a caller is checked against. A stub with no body and no such marker is still dropped.

On the pinned `cal-com` checkout, 8 abstract methods are kept that were dropped before. Three calls that ended `dynamic` now resolve to one of them, and no other Symbol's fingerprint moves. An `aburi diff` against an IR an earlier version wrote reports the 8 as no longer dropped.
