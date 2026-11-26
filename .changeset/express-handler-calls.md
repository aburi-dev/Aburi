---
"@aburi/core": minor
"@aburi/framework-express": minor
"@aburi/framework-trpc": patch
---

An Express registration calls every handler and middleware it names, so their effects reach the route and swapping a route's handler for one that writes is a logic change that reports the write. `use` and mounts call what they hand over. An inline function, a factory call, a computed member, a member of `this` and a spread whose contents the statement does not show (`...guards`) add no call.

Where one Symbol holds several routes, as a `.route(path)` chain or a statement chaining several registrations does, each of its routes' middleware entries is prefixed with the method it guards (`put:requireAdmin`), and a route that takes none is marked (`get:`). A `.route(path)` chain is prefixed and marked even while it holds one method. Moving a guard to another method, adding a method or dropping one moves `logic`. What `use` takes keeps bare names. `derivedBy` names every method of a chain, the one the Symbol is named after first.

`@aburi/core` exports `referenceCalls`, the reading framework-trpc used for the base procedure and middleware a procedure is built on, now shared by both plugins.
