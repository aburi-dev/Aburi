---
"@aburi/lang-typescript": minor
---

Read a member's own modifiers into its normalized string: a method's or an accessor's `override`, `?`, `get` and `set`, and a field holding a function's `override`, `readonly`, `accessor` and `?`. Adding `override` to a method, making it optional (`m()` → `m?()`) or turning it into a getter (`m()` → `get m()`) moved only its class, since the member was described by its body and parameter list alone; it now moves the member's `syntax` too. A member written with none of these keeps the string it had.

This moves the `syntax` fingerprint of every member written with one of these modifiers, every getter and setter included, so an IR scanned before this release, compared with one scanned after, reports those members as syntax-only changes, with `api` and `logic` unchanged, and trips `--fail-on changed` or `syntax-changed`. On this repository, scanning one tree with both versions moves the `syntax` fingerprint of 3 of its 5,580 Symbols, all methods (one `override`, two getters), and no `api` or `logic` fingerprint. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
