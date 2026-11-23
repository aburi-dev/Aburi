---
"@aburi/lang-typescript": patch
---

Leave a parameter, a `catch` binding or a local out of `signature.throws`, so renaming one is no API change. A thrown identifier, the constructor of `throw new` and the callee of a thrown call are recorded only when the name they start with is bound by the module, an import or the global scope: `catch (e) { throw e }` → `catch (error) { throw error }` no longer lists the function under API changes, and `throw TIMEOUT` for a module-level `TIMEOUT` still records it.

The api fingerprint moves once for a Symbol that threw such a name, with no change to the source: on the pinned `cal-com` checkout, 171 of the 14,531 kept Symbols, which threw `error`, `err`, `reason`, `e` and a few other locals. An `aburi diff` against an IR an earlier version wrote reports them as changed; one that scans both sides with this version does not.
