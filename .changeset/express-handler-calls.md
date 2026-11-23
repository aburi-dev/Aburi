---
"@aburi/core": minor
"@aburi/framework-express": minor
"@aburi/framework-trpc": patch
---

An Express registration calls every handler and middleware it names, so their effects reach the
route and swapping a route's handler for one that writes is a logic change that reports the
write. `use` and mounts call what they hand over. Inline functions, factory calls and spreads add
no call.

A `.route(path)` chain, or any statement that registers several methods, prefixes each middleware
entry with the method it guards (`put:requireAdmin`), and marks a method of several that takes
none (`get:`). Moving a guard to another method, adding a method or dropping one moves `logic`.
`derivedBy` names every method of a chain, the one the Symbol is named after first.

`@aburi/core` exports `referenceCalls`, the reading framework-trpc used for the base procedure and
middleware a procedure is built on, now shared by both plugins.
