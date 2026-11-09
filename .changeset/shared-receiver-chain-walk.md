---
"@aburi/core": minor
"@aburi/lang-typescript": patch
"@aburi/framework-express": patch
---

`walkReceiverChain` and `chainCalls` export the walk down a call's receiver chain that `calleeName` reads. The TypeScript plugin's `call-statement:` entry and `chained-call` tag are read off it too, and so are the calls Express checks for a `.route()` path and names middleware from. A framework's name for a registration and the `call-statement:` entry can no longer drift apart, and no entry or name moves.

`chainCalls` passes an index as it passes a member access. A `const`, a default export or a class field whose value calls through an index now gets the functions its chain invokes or is handed before the index, as it already did through a member access. For example, `export const h = (() => { q() })()["run"]()` gets the invoked function as its body, with `invoked-function` on `derivedBy` and `q` in `calls[]`; before, that function was on no Symbol. Such a Symbol's `logic` fingerprint moves once where the function has rules or effects, and its `api` and `syntax` fingerprints stay. `hasRouteArguments` likewise finds a `.route()` path before an index, so `app.route("/users")["get"](listUsers)` hands it a handler. No registration the TypeScript plugin extracts has an index on its chain, so no route or middleware moves.
