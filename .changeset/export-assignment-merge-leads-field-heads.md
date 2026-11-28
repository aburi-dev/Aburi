---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

Give the value `export =` makes a module a Symbol. `export = function handler() {}` and `export = class UserService {}` are named by their own names, with the class's members, an anonymous one is `<default>`, a call handed a function is the `<default>` const `export default` gives it, and `export = handler` makes `handler` public. Each carries the new `derivedBy` entry `export-assignment`, which `@aburi/types` exports as `EXPORT_ASSIGNMENT_DERIVED_BY` and which names the module's export `export=` for the api fingerprint, so the statement becoming `export default` is an api change. A call reaches the value through `import h = require("./m")`, a member of it (`h.of()`) and a default import. Before, the statement extracted nothing, so the module's only export was in no Symbol and an edit to it reported nothing.

When an interface or a type alias is written above a function, a binding, an enum or a namespace of its name, the run-time declaration now leads the merged Symbol, as a class already did. `export type User = ReturnType<typeof User>` above `export const User = make(…)` is a `const` that keeps its calls instead of a type alias dropped with them, and `User()` resolves to it.

A field holding a function now carries its type annotation and its `=` in its normalized string, so editing the annotation, or rewriting the field as a method of its name, moves the member's `syntax` and not only its class's. Against an IR an earlier version wrote, every field holding a function reports a syntax-only change once.

`export default abstract class { … }` and a `static` index signature in a class body parse clean: the grammar refuses both modifiers, so the file is reparsed with them blanked, and the normalized string keeps them. Before, the default export lost every Symbol of its file, and the index signature left a parse error in its class.
