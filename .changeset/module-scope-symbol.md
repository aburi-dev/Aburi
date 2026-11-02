---
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/types": minor
---

Give what a file does when it is imported a Symbol, `<module>`

A top-level statement that declares nothing (`await prisma.user.deleteMany({})`, `doThing()`, `process.on("SIGTERM", () => shutdown())`, a top-level `for` or `try`) was in no Symbol, so the effects of a file that empties a table when it is imported were reported nowhere. They are now `<module>`'s. A declaration whose value is such a call is not covered yet (below).

- **IR.** A file with such statements gets one Symbol for them, `<module>`, with `kind: "module"`, visibility `internal` and `derivedBy: ["module-scope"]`. It holds them in source order, along with the statements of the file's namespace bodies. A callback written in one of them is absorbed into it, as into any parent. Declarations, imports and exports, registrations (their own Symbol) and directives (`"use client"`) stay out. A file with none of them has no `<module>`.
- **Registrations handed no function.** `app.use(cors())`, `app.get("/x", handler)`, or `await prisma.user.delete({ … })`, whose method is one a router registers through, has the call itself as its body, so the calls it makes on import are its own (`app.use` and `cors`). It had no body before, and those calls, the write included, were in no Symbol.
- **Qualified names.** `<module>` is the second reserved name beside `<default>`, and `@aburi/core` exports it as `MODULE_SCOPE_QNAME`.
- **Effects.** `<module>` carries the effects of the calls it makes, and by propagation those of the functions it calls. Nothing calls it and an import is not a call, so a file that imports it inherits none of them.
- **Functions invoked in place.** A const initialised by an immediately invoked function (`export const h = (() => { q() })()`, or `await (async () => { q() })()`) and a default export written as one (`export default (async () => { await main() })()`) have that function as their body, with `derivedBy` carrying `invoked-function`, which `@aburi/types` exports as `INVOKED_FUNCTION_DERIVED_BY`. The const had no body before and the default export had no Symbol, so the function's calls were in none.
- **Not covered yet.** A const or a default export whose value is a call handed no function (`const n = await prisma.user.deleteMany({})`, `export const app = express()`, `export default defineConfig({ … })`) still puts that call in no Symbol.

**Test files get a `<module>`.** Their `describe` and `it` blocks are their top-level code. Scanning this repository goes from about 10,000 calls to about 40,000, and the IR grows by about 60%. Like the file's other Symbols, a test file's `<module>` is test code: `diff.md` folds its changes into the `🧪 Test files` section, and `--fail-on-scope non-test` leaves it out of the gate.

**Older readers.** An Aburi released before this one refuses a stored IR that holds a `<module>` Symbol, because its qualified-name check does not know the name. `aburi diff <base>..<head>` scans both sides with the running version and is unaffected.
