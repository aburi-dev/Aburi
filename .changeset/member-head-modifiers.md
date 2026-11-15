---
"@aburi/lang-typescript": patch
---

Read a member's `override` and `?` into its normalized string, and a field holding a function's `override`, `readonly`, `accessor` and `?`. Adding `override` to a method, or making it optional (`m()` → `m?()`), moved only its class, since the member was described by its body and parameter list alone; it now moves the member's `syntax` too. A member written with none of these keeps the string it had; one written with any of them gets a new `syntax` fingerprint, so an `aburi diff` against an IR an earlier version wrote reports it as syntax-changed once.
