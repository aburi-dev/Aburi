# Call Resolution

Specification of how Aburi resolves the identity of a callee at a call site — turning the raw callee string in `Symbol.calls[].target` into a workspace-relative Symbol id in `Symbol.calls[].resolved`.

References:
- [`ir-schema.md`](./ir-schema.md) §10 — the shape of `Call` and the `resolved` field
- [`lang-plugin.md`](./lang-plugin.md) §2.2, §4.4 — the Language Plugin's boundary (call resolution is out of scope) and the `CallCandidate` shape
- [`effect-plugin.md`](./effect-plugin.md) — how effect classification takes precedence over resolution
- [`effect-propagation.md`](./effect-propagation.md) — the consumer that propagates effects along resolved edges
- [`slice-view.md`](./slice-view.md) — the consumer that clusters over the resolved call graph
- [`lsp-enrichment.md`](./lsp-enrichment.md) — the optional layer that refines resolution outcomes

---

## 1. Purpose

`Symbol.calls[].target` is a normalized callee string produced by the language plugin (e.g. `pricing.calculateTotal`, `this.repo.save`, `handler`). It is a **string**, not a reference. Effect propagation and Slice View both need edges over the **Symbol universe** — that is, `<language>:<file>#<qname>` ids on both endpoints.

Call resolution is the pass that fills in `Symbol.calls[].resolved` with the id of the callee Symbol, or leaves it `null` when identity cannot be established with sufficient confidence.

The pass runs in the core (`@aburi/core`). The language plugin does not do resolution ([`lang-plugin.md`](./lang-plugin.md) §2.2 — "Call resolution (filling in `calls[].resolved`)" is out of scope).

## 2. Two-Tier Resolution Model

Aburi runs in two environments:

| Tier | Availability | Refines |
|---|---|---|
| **Untyped (default)** | always | resolves by import binding + qualified-name matching over the Symbol table |
| **LSP-enriched (optional)** | when a language server is running and available (spec: [`lsp-enrichment.md`](./lsp-enrichment.md)) | resolves `this` / `super` method dispatch through the actual receiver type; interface implementations are planned (§5.3) |

The two tiers share a **single output contract** (§7). Enabling LSP MUST NOT change the shape or ordering of `calls[]`; it only lifts more `resolved: null` entries to non-null and lifts `confidence`. This preserves time-series diff stability (`overview.md` §2 — "diff stability" is non-negotiable).

Every implementation of a language plugin's call-resolution helpers must therefore expose the two tiers as one function whose *inputs* differ but whose *output types* are identical.

## 3. Inputs to the Resolver

The resolver runs after all files have been parsed and `Symbol[]` is available. Its inputs are:

| Input | Origin | Notes |
|---|---|---|
| `symbolTable` | `@aburi/core` | index of every Symbol keyed by id and by `(file, qname)` |
| `symbolCandidate` | `@aburi/lang-typescript` (`extractSymbols`) | the caller — provides `id` and `SourceRange.file` |
| `Symbol.component` | `@aburi/core` (`runFilePipeline`) | the caller's Component, which §4.5 scopes its search to. Not a language-plugin field: `SymbolCandidate` has none, and the core writes it from the file's path against `Component.roots[]` ([`component-detect.md`](./component-detect.md) §12) |
| `call` | `walkBody` `CallCandidate` | provides `target`, `line`, `argumentCount`, `inAwait`, `inNew`, `literalArgs` |
| `importTable` | `parseFile().imports` | per-file `ImportEdge[]` (`lang-plugin.md` §4.2) — the resolver reads this to know what a bare identifier binds to |
| `localScope` | derived per call | the caller Symbol's parameters (`Signature.inputs`), and each call the language plugin marks `localHead`: §4.2 reads both |
| `receiverType` | `walkBody` `CallCandidate` | the named type a receiver is declared with, where the language plugin reads one off the source (`lang-plugin.md` LP20n, LP20n2, LP20n3, LP20n5). It reaches the resolver as `declaredReceiverTypes`, keyed by the calling Symbol, the line and the target, and §4.7.1 reads it |
| `superclass`, `instanceMembers` | `extractSymbols` `SymbolCandidate` | for a class that extends another, the name its `extends` writes, as its module binds it, and every instance member it declares itself, a Symbol or not (`lang-plugin.md` LP20n4). They reach the resolver as `classHeritages`, keyed by the class's Symbol id, and §4.7.1 walks them |
| `valueType` | `extractSymbols` `SymbolCandidate` | for a variable, the named type its value is declared with or the class a `const` is constructed from, as its module binds that name (`lang-plugin.md` LP20n6). It reaches the resolver as `valueTypes`, keyed by the variable's Symbol id, and §4.7.1 reads it for a call through a name an import binds |
| `importedReceiver` | `walkBody` `CallCandidate` | set where one of the module's imports binds the receiver's leading name and no scope nearer the call declares it again (`lang-plugin.md` LP20n7). It reaches the resolver as `importedReceivers`, keyed as `declaredReceiverTypes` is, and §4.7.1 reads a `valueType` only for such a call |
| `returns` | `extractSymbols` `SymbolCandidate` | for a function, a method or a variable holding one by name, what a call of it gives back, as its declaration says: a type, the receiver itself (`self`), the call its body returns, or the name the variable holds (`lang-plugin.md` LP20n8). It reaches the resolver as `returnSources`, keyed by the Symbol's id, a call as its `makeCallSiteKey`, and §4.7.1 reads it for a call whose `receiverCall` names a call of the Symbol |
| `receiverCall` | `walkBody` `CallCandidate` | the call whose result the receiver is, written in the chain or initializing the `const` the receiver names (`lang-plugin.md` LP20n9). It reaches the resolver as `receiverCalls`, keyed as `declaredReceiverTypes` is, the call as its `makeCallSiteKey`, and §4.7.1 reads it |
| `unboundHead` | `walkBody` `CallCandidate` | set where no scope around the call, the module's included, declares the target's leading name (`lang-plugin.md` LP20n10). It reaches the resolver as `unboundHeads`, keyed as `declaredReceiverTypes` is, and §8.1 reads it to bucket a call it leaves unresolved; it never resolves one |
| `localHead` | `walkBody` `CallCandidate` | set where a scope nearer the call than the module declares the target's leading name: a parameter, a callback's parameter, a local, a nested function, a `catch` binding (`lang-plugin.md` LP20n11). It reaches the resolver as `localHeads`, keyed as `declaredReceiverTypes` is, and §4.2 reads it |
| `workspacePackageNames` | `@aburi/core` (`scan`) | the `package.json#name` of each workspace package ([`ir-schema.md`](./ir-schema.md) §11.3); §4.4 reads it to tell a package of the workspace from one outside it |
| `receiverTypes` | LSP layer only | actual type at each call receiver — absent in the untyped tier |

The **caller's file path** is the anchor; resolution is always evaluated in the frame of one call site inside one Symbol.

## 4. Untyped Resolution Rules

The untyped tier resolves callees by **name binding**, not by type. It runs five ordered steps; the first step to return a match wins. A call through a field of `this` that they leave unresolved is then tried through the type the field is declared with, which is reached by binding its name in the same way (§4.7.1). A step that binds the leading identifier to a declaration whose members it can see, or to an import under a name the declaration does not have, ends the search even when it finds no match there (§4.3, §4.4).

### 4.1 Step order

```
1. Local scope   — a variable or nested function in the caller's Symbol matches the leading identifier
2. File scope    — a top-level Symbol in the same file matches the leading identifier
3. Import scope  — the leading identifier is bound by an import at the top of the file
4. Component scope — cross-file match within the same component (§4.5)
5. Workspace scope — cross-component match against a globally-unique qname (§4.6)
```

Steps 1–3 handle same-file / directly-imported calls. Steps 4–5 catch cases where the language plugin's normalized `target` already includes enough qualification to disambiguate (e.g. `PricingService.calculateTotal`) but the leading identifier is bound to no declaration whose members the resolver can see: nothing in the caller's file declares or imports it, the file declares it as a value that comes from elsewhere (§4.3), or a named import that keeps the exported name reaches no module declaring it, as through a workspace package's name §4.4.1 maps to no file the scan read or a barrel whose re-exports lead to no declaration (§4.4.2).

### 4.2 Step 1: local scope

For `target` of the form `name` or `name.<rest>`, if `name` is a parameter, local variable, or nested function declared in the caller Symbol's body, the call is **unresolvable** (the receiver is a runtime value, not a source Symbol) and `resolved` stays `null`. Confidence of this determination is `high` — a local shadow is textual and unambiguous.

The resolver knows a name is local in two ways. The caller Symbol's own parameters are in its `signature` (below). Every other local is the language plugin's to report, since only it reads the scopes: a call it marks `localHead` ([`lang-plugin.md`](./lang-plugin.md) LP20n11) has a head that a scope nearer the call than the module declares, so no declaration of the module or of its imports is what the name holds. That covers a `const`, a `let` or a nested function of the body, a block's binding, a `for…of` or `catch` binding, a function expression's own name, and a callback's parameter, which is a local of the Symbol whose body writes the callback. In `export function confirmDialog(id) { const deleteUser = (x) => log(x); deleteUser(id) }`, `deleteUser(id)` stays `null` though the file imports a `deleteUser` that writes to the database, so `confirmDialog` takes none of its effects. A class declaration's own name inside its body is the module's class, not a local. A type the local is declared with still resolves the call (§4.7.1): the shadow ends steps 1–5, not the typed tier.

A parameter written as a destructuring pattern declares every name the pattern binds, and each of them shadows: `function f({ save }) { save() }` is the same local call as `function f(save) { save() }`. The resolver reads those names from `Signature.inputs[].bindings` ([ir-schema.md](./ir-schema.md) §7), never from the pattern text in `name`, so `{ a: b }` shadows `b` and `{ a = fallback }` shadows `a` but not `fallback`. A rest parameter follows the same rule: `...[save]` is named `[save]` and binds `save`, while `...save` is a single name, `save`, and needs no list.

Both rules read the parameters from the caller Symbol's own `signature`, so neither reaches a function that a `const` or a class field only hands to a call: `export const POST = withAuth(async ({ save }) => { await save(1) })` is a `const` with a null `signature` whose bodies are its call and the arrow ([lang-plugin.md](./lang-plugin.md) LP7c), and so is the class field written alike (`class C { handle = withAuth(({ save }) => { save() }) }`, LP20f1). Route handlers and RPC procedures are commonly written like this. There `localHead` is what shadows the callback's parameter. A language plugin that marks no call leaves `save()` to resolve to an imported `save` as though no parameter declared it, taking its effects, and in the class field the wrong edge also reaches every caller of `this.handle()`.

Rationale: promoting a locally-scoped identifier to a Symbol id would produce false edges. Emitting `null` here is a **correct** resolution, not a failure.

### 4.3 Step 2: file scope

If `name` matches a top-level `Symbol.name` in the same file (Symbol id → `<lang>:<caller.file>#<name>`), emit `resolved = that Symbol.id` with `confidence = high`.

For dotted targets (`name.method`), the file-scope match is against `name` first; if `name` resolves to a Symbol in the same file, `resolved` is set to the member the rest of the target names, when that Symbol exists. A dot in the target joins a receiver to a member, and the member's qualified name uses the separator its receiver gives it: read through a class's name, a member is on the static side, which [`ir-schema.md`](./ir-schema.md) §3.2 spells `::`. So each step takes `<receiver>::<segment>` when that Symbol is kept and `<receiver>.<segment>` otherwise: `C.m` reaches `C::m` over an instance member `C.m`, and `C.Inner.g` reaches `C::Inner.g`. If the member Symbol is absent (dynamic method, method inherited from a base class, etc.), `resolved` stays `null` (do not fabricate ids for methods that never appear in the Symbol table).

The search ends there, member or not, when `name` is a declaration whose members are Symbols of the file: a class, an enum or a namespace that is not an `ambient-declaration`, or a `const` holding an object literal (`derivedBy` carrying `object-literal-initializer`, [`lang-plugin.md`](./lang-plugin.md) LP7d). A member such a declaration lacks is declared nowhere, so no later step is consulted, and a same-named member of another file is not a candidate: in a file that declares `class Logger {}`, `Logger.log()` stays `null`, bucketed `no-match` (§8.1), however many other files declare a `Logger.log`. The declaration may be a dropped Symbol, such as a class of fields alone ([`drop-list.md`](./drop-list.md) §4.2): dropping it keeps it out of `resolved`, not out of what its name means, so the search ends there too, and a kept member it has is still reached.

Any other declaration of `name` leaves a missing member to the later steps, because its members may be declared in another file:

- an `ambient-declaration`, since `declare class Tracker { … }` or `declare const Tracker: { … }` says the value is defined elsewhere;
- a `destructured-binding` (`const { userService } = require('./user-service')`);
- a function;
- a `const` whose value the resolver cannot see. `const userService = require('./user-service')` is one: a `require()` produces no `ImportEdge`. `const Logger = makeLogger()` is another, and the IR cannot tell the two apart, so a same-named member of another file is reached through either.

An interface or a type alias binds no value and is not looked at. A class written below an interface of the same name is folded into a Symbol of the interface's kind ([`lang-plugin.md`](./lang-plugin.md) §4.3.1), so `Logger.log()` there goes on to the later steps as well.

Ending the search takes exactly one kept top-level Symbol named `name`, or none kept and a dropped declaration. Two kept leave the step without an answer, their ids recorded as `ambiguous` candidates, and the search goes on.

Import scope (§4.4) composes a dotted tail past the imported name the same way. Component and workspace scope (§4.5, §4.6) compare the whole target with `Symbol.name` verbatim and compose nothing, so a static member is reached only through file or import scope.

### 4.4 Step 3: import scope

Read `importTable[caller.file]`. If `name` is the local binding of an `ImportEdge.symbols` entry (a named or a default import) or matches an `import * as name` alias, resolve `name` to the imported source module. A named import is looked up under the name the module exports it as, the half of the entry before ` as `. A module that exports the name without declaring it, as a barrel does, is read through its re-exports to the module that declares it (§4.4.2), and every rule below then reads that module and that name as though the import had named them.

A **default import** arrives as `"default as name"` ([`lang-plugin.md`](./lang-plugin.md) LP24a) and is looked up as the module's default export instead: the file's `<default>` Symbol ([`ir-schema.md`](./ir-schema.md) §3.2), or the top-level declaration whose `derivedBy` carries `export-default` — `export default function makeApp`, the `const f = …; export default f` of [`lang-plugin.md`](./lang-plugin.md) LP6a, or the `export { connect as default }` of LP6c. The importer chooses `name` freely, so it plays no part in the lookup, and a named export that happens to share it is never taken. A dotted tail composes past the default export's own name as §4.3 composes it: `S.run()` through `import S from './y'` reaches `Svc::run` in a module that writes `export default class Svc`. A module with no default export leaves the call `null`, bucketed `no-match` (§8.1). Two default exports in one module (TS2528, an ordinary state in the middle of an edit) leave it `null`, bucketed `ambiguous` with both candidates recorded, rather than linking to either.

Sub-cases:

| Import shape | Resolution |
|---|---|
| `import { X } from './y'` | `name = X` → resolve to `<lang>:<resolved-file>#X` |
| `import { X as Alias } from './y'` | `name = Alias` → resolve to `<lang>:<resolved-file>#X` (original name) |
| `import * as ns from './y'` | `name = ns` and `target = ns.foo` → resolve to `<lang>:<resolved-file>#foo` |
| `import Default from './y'`, `import { default as Default } from './y'` | `name = Default` → resolve to the module's default export: `<lang>:<resolved-file>#<default>` when it is anonymous, `<lang>:<resolved-file>#makeApp` when it is `export default function makeApp`; a named export called `Default` is not taken |
| `import type { X } from './y'` | no call edge (type-only imports produce no runtime edge). Like every import, a `via: import` Component edge when it crosses a Component boundary ([`ir-schema.md`](./ir-schema.md) §11.3) |
| `import('./y')` (dynamic) | ignored at the target site. Like every import, it is a `via: import` Component edge when it crosses a Component boundary ([`ir-schema.md`](./ir-schema.md) §11.3) |
| `import './y'` (for its effects) | binds nothing, so no call resolves through it. What `./y` does when it is imported is its `<module>` Symbol ([`ir-schema.md`](./ir-schema.md) §3.3), which no target names, so no call edge reaches it from this or any other import. Like every import, it is a `via: import` Component edge when it crosses a Component boundary ([`ir-schema.md`](./ir-schema.md) §11.3) |
| bare specifier the language maps to a workspace file (`'@app/billing'` through `compilerOptions.paths`) | as a relative specifier: resolve against the file it maps to (§4.4.1, step 2) |
| any other bare specifier (`'lodash'`) | out-of-workspace — `resolved` stays `null`, confidence `high` (this is a definite external, not a failure); a qualified target through a named import that keeps the exported name goes on to Step 4 only for a workspace package's name |

A default export is reached only as one of those two Symbols. A call (`export default withAuth(async (req) => { … })`, `export default withAuth(Page)`) is the file's `<default>` Symbol, a `const` ([`lang-plugin.md`](./lang-plugin.md) LP7c1), and is reached as any `<default>` is. The edge reaches the call, not what it is handed by name: `withAuth(Page)`'s `<default>` calls `withAuth` alone, so a caller takes `withAuth`'s effects and none of `Page`'s. Two spellings are not reached. A default export that is any other value rather than a declaration or a call (`export default { Page }`, `export default new Router()`) has no Symbol. An anonymous `export default class` has no member Symbols for a dotted tail to reach, since `<default>::run` is not a qualified name ([`ir-schema.md`](./ir-schema.md) §3.2). A default re-exported from another module (`export { default } from './impl'`) is that module's default export (§4.4.2). Each of the first two leaves the call `null`, bucketed `no-match`.

An import ends the search as file scope does (§4.3), member or not, in three cases:

- **It binds `name` under a name the declaration does not have.** That covers an alias (`import { Logger as B }`), a default import (`import L from …`) and a namespace import (`import * as ns from …`). Steps 4–5 compare the target as written, so `B.log`, `L.log` or `ns.Logger.log` could only match a namesake there, never the declaration the import reaches. So `B.log()` through `import { Logger as B } from './barrel'` stays `null` where the barrel's re-exports lead to no declaration of `Logger`. So does `L.log()` through a default import of a module with no default export, or of an anonymous `export default class`. The rule holds for a bare specifier §4.4.1 maps to no file too, where the call is bucketed `external` (§8.1).
- **It keeps the exported name, and its module declares that name as §4.3 requires**, kept or dropped, itself or through its re-exports. So where `base-logger.ts` declares a `Logger` class with no `log`, `Logger.log()` through `import { Logger } from './base-logger'`, or through a barrel that re-exports it from there, stays `null`, bucketed `no-match`.
- **It names a package outside the workspace**: a bare specifier that §4.4.1 maps to no file the scan read and whose package name (`@scope/name`, otherwise its first segment) is no workspace package's. The name is that package's export, so a workspace Symbol that shares its spelling is a namesake: `Logger.log()` through `import { Logger } from '@nestjs/common'` stays `null`, bucketed `external`, though the workspace declares a class `Logger` with a `log`. That a language plugin maps the specifier says nothing of whose it is, since `baseUrl` maps every bare specifier to a path under it. A specifier with no package name, such as an alias written `@/lib` or `~/lib`, is not one.

A named import that keeps the exported name and reaches no such declaration goes on to Step 4 (§4.5). The target then spells the declaration's own name, so Steps 4–5 can find it. That happens for:

- a workspace package's name, or a subpath of it, that §4.4.1 does not resolve to a file, as when its manifest names only files the scan did not read (built output that is not checked in). Steps 4–5 are how a call into such a package reaches the Symbol it names;
- a relative specifier that resolves to no file the scan read;
- a module that does not declare the name and whose re-exports lead to no declaration of it (§4.4.2), such as a barrel that re-exports it from a module the scan has no Symbol in;
- a module that declares it as a value the resolver cannot see, such as `export const Logger = makeLogger()`.

Resolving `./y` to a Symbol file requires the file-path normalizer defined in §4.4.1.

#### 4.4.1 Import specifier resolution

For a specifier `'./y'` (or `'../y'`, `'@workspace-alias/foo'`) in file `apps/billing/src/svc/InvoiceService.ts`:

1. **Relative** (`./` or `../` prefix, or exactly `.` or `..`) — resolve against the caller's file directory.
   - A specifier that names a directory outright — one whose last segment is empty, `.` or `..` (`.`, `..`, `./`, `../`, `./y/..`) — probes only that directory's `index.<ext>` (step 3's directory form), never `<dir>.<ext>`. TypeScript resolves these to the index outside ESM mode and not at all inside it; the resolver carries no per-file module mode, so it always takes the former. A directory's `package.json#main`, which TypeScript consults before `index`, is not read: the resolver reads no filesystem state
   - A specifier written with an emitted-JavaScript extension first probes the sources that compile to it, in TypeScript's order less its declaration files: `.js` → `.ts`, `.tsx`, `.js`, `.jsx`; `.jsx` → `.tsx`, `.ts`, `.jsx`, `.js`; `.mjs` → `.mts`, `.mjs`; `.cjs` → `.cts`, `.cjs`. Under `node16`/`nodenext` a relative import of `repo.ts` has to be written `./repo.js`, and TypeScript resolves it to `repo.ts` even when a `repo.js` sits beside it. The written extension is always probed, in its place in the row; the others only when they are in the resolver's probe list (step 3). When none of them names a file, step 3 carries on from `<path>.<ext>`
2. **Path alias** — a bare specifier is mapped by the language plugin's `ImportResolver` ([`lang-plugin.md`](./lang-plugin.md) §4.8): for TypeScript, the `paths` and `baseUrl` of the importing file's nearest `tsconfig.json` (§4.8 there). The scan asks it while it extracts the file, for each bare specifier the file imports, where something reads the answer: one of its Symbols makes a call, one of its edges re-exports (§4.4.2), one of its declarations names what a value is (a class's `superclass`, a variable's `valueType`, a function's `returns`, §4.7.1), all read through the declaring file's imports, or the file is in a Component, whose import edges map it too ([`ir-schema.md`](./ir-schema.md) §11.3). It hands the resolver the paths in the order the plugin gives them. Each is probed as step 3 probes a relative specifier's path, from the workspace root, against the files the scan read; the first that names one is the module, and the import resolves against it as a relative one would (§4.4). A specifier mapped to no such file — a package's, or one the plugin's resolver failed on — stays bare: `external` when nothing else resolves the call (§8.1), and on to Step 4 for a qualified target through a named import that keeps the exported name of a workspace package (§4.4).
   - A workspace package's name (`pnpm-workspace.yaml`, `workspaces`), or a subpath under it, is then mapped by the scan from the package's `package.json`, after the plugin's paths, as TypeScript reads `paths` before a package. With `exports`, its paths are the targets of the subpath's entry: the key written out, else the `*` pattern with the longest prefix, then the longest key, its match put in each target. Every target of that entry counts, each condition's in the order the manifest writes them and each item of a fallback list in turn, since which conditions the workspace's tooling sets is not known; a source condition such as `"source": "./src/index.ts"` is commonly written first. A target that does not start with `./`, or leaves the package, is skipped, and a subpath the entry does not list, or excludes with `null`, maps to nothing. Without `exports`, or with `"exports": null`, the paths are `main`, `module`, `types` and `typings`, then the package's directory, and a subpath is the path under the package. A name two workspace manifests share maps to neither, since nothing tells which package an import means. Each is probed as above, so a `main` of `./index.js` reaches `index.ts`, and one naming built output the workspace does not hold is passed over. The resolver reads no manifest itself: the scan hands it the paths with the plugin's.
   - For other languages: the equivalent lookup surface the plugin declares, through the same `ImportResolver`.
3. **Extension probing** — the probe list is `ResolveCallGraphInput.fileExtensions`: dot-less extensions (`ts`, where a language plugin's `fileExtensions` in [`lang-plugin.md`](./lang-plugin.md) §4.1 writes `.ts`), the standard TypeScript / JavaScript set unless a caller sets it. Try the path as written, then `<path>.<ext>` in the list's order, then `<path>/index.<ext>` in the same order. A specifier that names a directory (step 1) skips straight to `<path>/index.<ext>`; a specifier with an emitted extension has step 1's sources tried in place of the path as written, ahead of the other two. The path as written is tried whatever the probe list holds.
4. **Known file** — confirm the resolved absolute path (workspace-relativized to POSIX) is a file the scan read in the caller's language: a Symbol id prefix in `symbolTable`, or a file the scan read without a Symbol, as a barrel that only re-exports is (`ResolveCallGraphInput.moduleFiles`). If not, `resolved` stays `null`, `confidence` = `high` (a definite miss).

Step 2's mapping is read by the language plugin from the build configuration it knows, once per scan on each thread that extracts files ([`lang-plugin.md`](./lang-plugin.md) §4.8), and is handed to the resolver as data before it runs; the resolver itself reads no configuration. Determinism follows: the plugin's answer for a file and specifier depends only on the configuration files, the candidate order is fixed by that answer, step 1's table and the probe list, and no candidate is checked against the filesystem (only against `symbolTable`).

#### 4.4.2 Re-exports

A module can export a name it does not declare, and an import of the name then reaches the declaration through the module's re-exports, as TypeScript's does. The resolver reads them off the re-exporting module's own import edges ([`lang-plugin.md`](./lang-plugin.md) §4.2), each specifier resolved from that module's file as §4.4.1 resolves one from the caller's, and asks each module in turn:

1. **It declares the name, or exports a declaration under it.** A top-level declaration an export clause of the module exports under the name (`function stringType() {}` with `export { stringType as string }`, [`lang-plugin.md`](./lang-plugin.md) LP6c), kept or dropped, is the answer, since that is what the module exports as the name, whatever else it declares by that name: a call it reaches only through a dropped declaration stays unresolved rather than reaching the namesake. Otherwise a top-level Symbol of that name, kept, or a declaration whose members are Symbols of the file, kept or dropped (§4.3), is the answer. For `default` the answer is the module's default export (§4.4).
2. **An edge's `reexports` exports the name.** The chain goes on to the edge's module, under the name the entry takes from it: `export { A as B } from './m'` leads `B` to `A` in `./m`, and so do `import { A } from './m'` with `export { A as B }`, and `export { default as B } from './m'` to `./m`'s default export. An entry that takes the whole module (`export * as ns from './m'`) makes the name `./m`'s namespace, so the next segment of the target is looked up in `./m`, as through a namespace import, and a target with no next segment finds nothing.
3. **An `export * from` reaches it.** For any name but `default`, each edge marked `reexportsAll` leads the chain on to its module under the same name. One answer among them is the answer. Several that differ, a namespace among them, leave the call `null`, bucketed `ambiguous` with every declaration recorded (§8.1), whatever member a dotted target names and whichever of them declare it: ECMAScript exports no name two star exports disagree on.
4. **Otherwise the module does not export the name**, and the chain ends without an answer. So do a relative specifier that names no file the scan read, and a module the chain already asked for the name.

A bare specifier that maps to no workspace file ends the chain outside the workspace: on a named re-export always, and on `export *` when no other star export answers. The call is then bucketed `external` (§8.1), as one through a bare import of the caller's own is, since that module is where the name comes from. `export type * from` and type-only re-exports export no value and add nothing to the chain ([`lang-plugin.md`](./lang-plugin.md) LP26o, LP27e).

A chain that ends at a declaration is that declaration's import in every rule of §4.4: a dotted tail composes past it, the edge is `high`, a member the declaration lacks ends the search, and an alias, a default or a namespace import of a barrel reaches the declaration as it reaches one written in the module itself. A chain with no answer leaves the import where it was before, so a qualified target through a named import that keeps the exported name goes on to Step 4. The chain reads nothing but the import edges and the Symbol table, both complete before the resolver runs, so the answer for a module and a name is the same whichever file asks first.

### 4.5 Step 4: component scope

If steps 1–3 did not find the declaration the leading identifier is bound to (§4.3, §4.4) and `target` is a **qualified name** (`ClassName.method` or `Namespace.ClassName.method`), search `symbolTable` for a Symbol whose `name` equals `target` and whose `component` equals the caller's `component`.

- **Unique match** → `resolved` = that Symbol.id, `confidence = medium`. The target is unambiguous within the boundary, but no declaration the resolver can see vouches for it. The head is either imported under the declaration's own name from a module that does not declare it and whose re-exports do not reach it (a barrel over a module the scan does not see, a workspace package), declared as a value whose origin the resolver cannot see, or not bound at all.
- **Multiple matches** → do not resolve. `resolved` stays `null`, `confidence = medium` (ambiguity is real). Record the candidates for reporting (§8).
- **No match** → fall through to Step 5.

### 4.6 Step 5: workspace scope

Same as Step 4 but the search is over the whole workspace, not just the caller's component.

- **Unique match** → `resolved` = that Symbol.id, `confidence = low`. A globally-unique qname is weak evidence; consumers should treat these edges as suggestive rather than authoritative.
- **Multiple matches** → do not resolve. `resolved` stays `null`.
- **No match** → `resolved` stays `null`, `confidence = high` for the negative result (the callee is genuinely external or a runtime value).

### 4.7 Special normalized targets

The language plugin's `normalizeCallee` produces some targets that never resolve to a Symbol by name, and steps 1–5 MUST leave them unresolved. The exceptions are a call of a member of `this` in an instance member of a named class, a call through `super` in an instance member of a class that extends another, and a call through a field of `this` that the class declares with a named type, which §4.7.1 resolves after them, as it does a call through a name declared with a class and one through what another call gives back:

| Target shape | Reason |
|---|---|
| `this.<method>` | `this` is a runtime value; a member its class declares, or inherits from a class the resolver can bind, is §4.7.1's, any other requires typed dispatch (LSP tier) |
| `super(…)`, `super.<method>` | `super` is a runtime value too; the class the caller's class extends, where the resolver can bind it, and a member that class declares or inherits are §4.7.1's, any other requires typed dispatch (LSP tier) |
| `new <ClassName>()` receiver in a chain | `new` produces an instance of the class it names, which is §4.7.1's |
| method chains on non-identifier receivers (`getRepo().save`) | receiver is an expression result, not a name; what the call gives back, where its callee says, is §4.7.1's |

For what it leaves of `this` and `super`, the untyped tier writes `null` with `confidence = medium`; the LSP tier can promote these to real ids (§5.2).

#### 4.7.1 A receiver of a declared type

`this.repo.find(id)` beside `constructor(private readonly repo: UserRepository)` names its receiver's type in the source, and the language plugin reports it as the call's `receiverType`. A call that steps 1–5 leave unresolved is resolved through that type, as the untyped tier's last rule:

1. The type's name is bound as a target's leading identifier is in steps 2 and 3: a top-level Symbol of the caller's file, or a name an import binds, a dotted name (`repos.UserRepository`) composing past it. A class a drop rule removed is bound as a kept one is, since dropping keeps a declaration out of `resolved`, not out of what its name means: a subclass dropped as a pure DTO still holds what it inherits. Steps 4 and 5 are not searched: they match by spelling, so for a type they could only find a namesake.
2. The name must bind a class that declares the member the call's last segment names, as an instance member: `UserRepository.find`, never the static `UserRepository::find`, since the receiver is a value of the type. A class that does not declare it is read through the class it extends ([`lang-plugin.md`](./lang-plugin.md) LP20n4), bound as rule 1 binds the type, but from the file that declares the class, since that is where its `extends` is written, and so on up to the nearest class that declares the member: through `repo: AdminRepository`, where `AdminRepository extends Repository` and only `Repository` declares `find`, the member is `Repository.find`. The walk ends at the first class that declares the member: one that has a Symbol of it, kept or dropped, or that the language plugin lists the member among the instance members of (LP20n4). So the call stays unresolved rather than reaching the member it inherits where the class's own is one a drop rule removed, or one that has no Symbol: a field holding data (`find = make()`), a parameter property, or a name the class's code assigns to `this`. At run time the instance's own member is the one that runs. A field written only with its type (`find!: Repository["find"]`) declares no member, and the walk goes past it. The walk ends unresolved, too, at a superclass that binds no class and at a class it has already read.
3. `resolved` = that member, `confidence = medium`: the value can be a subclass's, whose override is then the member that runs.

`repo.find(id)` names it too where `repo` is declared with it: beside a parameter `repo: UserRepository`, a variable `let repo: UserRepository | null`, or `const repo = new UserRepository()`, in the module or in a function around the call. The language plugin reads the declaration the nearest scope around the call gives the name ([`lang-plugin.md`](./lang-plugin.md) LP20n3), and the same rule resolves the call to `UserRepository.find`. It runs after steps 1–5, so a name they bind, as file scope binds a module's `const` holding an object literal, keeps their answer, and a parameter, which step 1 leaves unresolved, reaches its type's member here.

`onlineManager.setOnline(true)` through `import { onlineManager } from "./onlineManager"`, where that module writes `export const onlineManager = new OnlineManager()`, names the type too, but in the module that declares the variable, which the language plugin reads off that file alone and reports as the variable's `valueType` ([`lang-plugin.md`](./lang-plugin.md) LP20n6): the class a `const` is constructed from, or a variable's annotation (`export let manager: Manager | null`). Where a call carries no `receiverType` and the language plugin marks it `importedReceiver`, since one of the module's imports binds the receiver's leading name and no scope nearer the call declares it again (LP20n7), the receiver, every segment of the target but its last, is bound as step 3 binds a name, through the caller's imports, an alias, a namespace import (`managers.onlineManager.setOnline()`) or a barrel's re-exports included, to a variable that has a `valueType`, dropped or kept. That type is bound as rule 1 binds one, but from the file that declares the variable, since that is where its declaration is written, and rules 2 and 3 resolve the call from that class: `OnlineManager.setOnline`, at `medium` confidence. A local of the name hides the import, and the plugin marks no call through it: a callback's parameter (`list.forEach((onlineManager) => onlineManager.setOnline())`), a block's `const`, a `for…of` or `catch` binding, a destructured `const`, or a parameter of the caller's. Such a call keeps the bucket steps 1–5 give it, as does one through a variable of the caller's own file, whose type the plugin reads on the call itself where it reads one (LP20n3), and which only file scope binds.

`getRepo().save(user)` names no type at the call, and nor does `repo.save(user)` beside `const repo = getRepo()`, but the function the receiver is a call of may say what it gives back. The language plugin reports, on a function, a method or a variable holding one by name, what a call of it gives back as its declaration says, as the candidate's `returns` ([`lang-plugin.md`](./lang-plugin.md) LP20n8): a type, from its annotation (`: UserRepository`) or from what every `return` gives back (`new UserRepository()`, a name declared with a type); the receiver itself (`self`), for an instance member annotated `: this` or whose every `return` gives back `this`; the one call its body returns (`return this.with(1)`); or the name a `const` holds (`export const create = UserRepository.create`). On a call whose receiver is a call's result, written in the chain (`getRepo().save()`, `builder().with(1).save()`) or initializing an unannotated `const` the receiver names, it reports that call as the call's `receiverCall` (LP20n9). Where a call carries no `receiverType` and steps 1–5 leave it unresolved, the call its `receiverCall` names is resolved, as any call is, and its callee's `returns` gives the class: a type is bound as rule 1 binds one, but from the file that declares the callee, where its declaration is written; a call gives the class that call's callee gives back; and a name is bound as step 3 binds one, from the variable's file, to a function kept or dropped, whose `returns` gives the class. `self` gives the class of the receiver the call was made on, as this rule or rule 1 found it, so `sub.with(1).save()` through `sub: Sub` reaches `Sub.save` though `with` is declared in the class `Sub` extends; a callee reached by a variable's name, or a receiver whose class the source does not say, gives none. Rules 2 and 3 resolve the call from that class, `UserRepository.save`, at `medium` confidence, and a chain resolves link by link: `builder().with(1).save()` reads `with`'s `returns` off the class `builder()` gives back. The call stays unresolved, in the bucket steps 1–5 gave it, where the call its receiver is the result of does, and where that call resolves only at `low` confidence, since a namesake found by spelling says nothing of what the call gives back. It stays unresolved, too, where two calls written alike on one line could each be the receiver's, where the callee names nothing it gives back or a type it binds to no class, and where what it gives back comes round to itself. A language server's hint is read only for what the rule leaves, as for any type the source declares.

`this.find(id)` in an instance member of `class UserService` names its receiver's type as well: the language plugin reports the class's own name as the call's `receiverType` ([`lang-plugin.md`](./lang-plugin.md) LP20n2), and the same rule resolves the call to `UserService.find`, a method or a field's function the class declares, and `this.load()` to `Base.load` where `UserService extends Base` and only `Base` declares `load`.

`super.find(id)` in an instance member of `class AdminService extends BaseService` names a type too, the class the caller's class extends: the language plugin reports the name its `extends` writes, `BaseService`, as the call's `receiverType`, and the same for a constructor's `super(…)` ([`lang-plugin.md`](./lang-plugin.md) LP20n5). The type is bound as rule 1 binds it: the caller's file is the one that declares the class, where its `extends` is written. `super(…)` resolves to the class it binds, at `high` confidence, as `new BaseService()` does by name. `super.find(id)` resolves to the member rule 2 reaches from that class, at `high` confidence, since `super` names one class, which no subclass replaces, so no override runs in its place. A member read through `super` is on the prototype, where a field is not, so the walk ends unresolved at a member a field holds (`find = () => …`), as it does at one a drop rule removed or one that has no Symbol. A target of more than two segments (`super.repo.save()`) is not resolved: the rule reads no type for the member between.

Being untyped, the rule runs whether or not a language server does, and the LSP tier reads a hint only for a call it leaves unresolved (§2, §5.4). The LSP layer hints no call through a field yet: it hovers only a two-segment `this.<method>` or `super.<method>` ([`lsp-enrichment.md`](./lsp-enrichment.md) §5). A `super.<method>` the rule resolves keeps its answer and reads no hint: `super` names one class, so a hint could only name the same member. For a `this.<method>` the hint is read first and the member the class declares or inherits only when no hint resolves the call, since the hint reads the class with all it inherits, from a mixin or a class the scan did not read included, at `high` confidence ([`lsp-enrichment.md`](./lsp-enrichment.md) §5).

What it leaves unresolved of a call through a name keeps the bucket steps 1–5 gave it (§8.1). What it leaves of a call through `this` or `super` stays in the `dynamic` bucket, which describes the call's own receiver, `this` or `super`, whatever its type turned out to be:

- a field that carries no `receiverType`: one with no annotation, but for a `readonly` one constructed from a class (`private readonly repo = new UserRepository()`), a union of two types or an inherited declaration, or one whose type's name a scope between the class and the module declares, the class's own type parameter included ([`lang-plugin.md`](./lang-plugin.md) LP20n);
- an interface-typed field, which binds no class. Its implementers are left for §5.3, which is planned, so nothing resolves such a call today;
- a type the file binds to no class whose members the resolver can see: a class imported by a package name that §4.4.1 maps to no workspace file, or through a barrel whose re-exports do not reach it (§4.4.2);
- a type whose name binds more than one declaration, and a class that neither declares the member nor reaches it up the classes it extends (rule 2), as one that extends a mixin (`extends Mixin(Base)`) or a class of a package the scan did not read does. These end in `dynamic` too, not in `ambiguous` or `no-match`;
- a `this` the plugin names no class for: a static member's, where `this` is the class, a class expression's or an anonymous class's, a class a function or a namespace declares, whose name a reader binds apart, and an object literal's method or a `function` that binds its own;
- a `super` the plugin names no class for, in a static member or a class that extends a call, and through one it names, a member a field holds, one a drop rule removed or one that has no Symbol, and a target of more than two segments (`super.repo.save()`).

The type is read per key: the calling Symbol, the line and the target. When every call on a key names one type, they all resolve through it. When they do not, an untyped call on the key included, none does, since which call a type was written for is lost. Two `this` can share a key on one line, the method's and a nested class's or a `function`'s.

## 5. LSP-Enriched Resolution Rules

When LSP is available, resolution runs a second pass that reads receiver types.

### 5.1 Additional inputs

- `receiverType(callSite)` — the resolved type of the receiver expression at the call site, read from the language server's `textDocument/hover` answer for a `this` / `super` receiver (a `textDocument/typeDefinition` lookup for other receivers is planned with §5.3).
- `implementers(interfaceName)` — the set of Symbols known to `implements`/`extends` the given interface (from `textDocument/implementation`; planned with §5.3, the pass issues no such request yet).

The exact protocol subset used, plus fallback and timeout policy, is specified in [`lsp-enrichment.md`](./lsp-enrichment.md) §4. This document only names the two capabilities and treats them as inputs.

### 5.2 Method dispatch through `this` / `super`

For `this.<method>` in a caller Symbol whose parent class C is known:
- Resolve to `<lang>:<file>#C.<method>` when that Symbol exists.
- If C is a subclass, walk the class hierarchy via `implementers`; the nearest ancestor that declares `<method>` wins.
- `confidence = high` when the resolution is direct on C, `medium` when it required walking the hierarchy.

For `super.<method>`: same but starting one level up the class hierarchy.

A hint the resolver declines — one whose receiver kind is not the one its call site writes, or one naming a Symbol a drop rule removed — falls through to §8.1 like any other miss, or for a two-segment `this.<method>` to the member the class declares or inherits (§4.7.1), and is counted in `stats.lspEnrichment.hintsRejected` ([`lsp-enrichment.md`](./lsp-enrichment.md) §7.2). It has to be counted here because the enrichment pass has returned by the time the hint is read, so nothing else in the pipeline can tell a hint that was refused from one that was never produced.

### 5.3 Interface-typed receivers

> **Status**: planned. The LSP pass issues no `textDocument/typeDefinition` or `textDocument/implementation` request yet and hands the resolver no implementers, so every interface-typed call stays `null`, whatever number of classes implements the interface. The rules below are what it will do.

For `repo.save(...)` where `repo`'s LSP type is `IRepository`:
- Look up `implementers(IRepository)` — the set of implementing classes.
- If it is a **single class**, `resolved` = that class's `.save` Symbol, `confidence = medium`.
- If it is **multiple classes** and DI wiring is knowable via the framework plugin (`framework:nestjs:provider` binding), the framework plugin would supply the chosen implementer via a hook (§7.4, planned); until that hook exists the call stays `null`.
- If ambiguous, `resolved` stays `null` — do not silently pick one.

### 5.4 Untyped result preservation

If the untyped tier already resolved a call, the LSP tier does not overwrite it — the untyped result is authoritative for cases the type layer cannot see (barrel re-exports pointing at a different declaration file, for instance). The LSP tier only touches entries where the untyped tier left `resolved: null`. The one rule read after it is §4.7.1's for a two-segment `this.<method>`, whose class the hint reads too, with what it inherits.

Exception: if the untyped tier resolved to a Symbol id that no longer exists in `symbolTable` (deleted between passes — should not happen, but defensively), the LSP tier may replace it.

### 5.5 Determinism of LSP results

Language server responses can be non-deterministic across runs (server startup order, cache state, order in which files were indexed). To keep the IR deterministic:
- The resolver reads all needed LSP data into an in-memory cache **before** emitting resolutions.
- Cache lookup is by `(file, line, column)` — never by wall-clock ordering.
- Ambiguous LSP answers (e.g. multiple candidates for `typeDefinition`) are resolved with a canonical tiebreak (lexicographic on Symbol id) so the same input produces the same output regardless of server response order.

## 6. Dynamic Dispatch and Higher-Order Calls

Some call shapes cannot be resolved statically — with or without LSP. The specification is explicit about which shapes are left `null` **by design**.

| Shape | Behavior | Confidence |
|---|---|---|
| `callback(...)` where `callback` is a parameter | `null` | `high` (a parameter is genuinely runtime data) |
| `map[key](...)` — dispatched via computed key | `null` | `high` |
| `factory().method(...)` — receiver is an expression | `null` (untyped); LSP may resolve when return type is a concrete class | `medium` / `high` |
| `arr.map(fn)` where `fn` is a locally-declared function passed by reference | The **outer** call (`arr.map`) is resolved as usual; the **passed** `fn` produces no edge from the caller Symbol (the reference itself is not a call). If `fn` is invoked later inside `arr.map`, that invocation lives in the library's implementation, not in workspace source. | n/a |
| `await Promise.all([fn1(), fn2()])` | Each element `fn1()` / `fn2()` is a normal call and is resolved separately. `Promise.all` itself resolves to the external global. | as usual |
| a reference a framework runs on the Symbol's behalf, added as a call by its framework plugin ([`lang-plugin.md`](./lang-plugin.md) §5.2.6): `protectedProcedure` and `isAdmin` in `protectedProcedure.use(isAdmin).mutation(fn)` | Resolved as a call written at the reference's line. Unlike the `fn` above, the framework runs it on every invocation of the Symbol, which is what the edge says. | as usual |
| decorator invocation (`@Post('/x')`) | Not a call from `walkBody`'s point of view — decorators live in `Symbol.decorators[]`, not `Symbol.calls[]`. Framework plugins handle them separately. | n/a |

Rule of thumb: **when the receiver is not a name, we do not fabricate a name for it**. A `null` `resolved` with an explicit reason is more useful downstream than a plausible but wrong id.

## 7. Contract with `@aburi/core` Symbol Graph

The Symbol call graph is built by projecting the resolved `calls[]` into edges.

### 7.1 Edge shape

```
CallEdge {
  from: SymbolId          // caller symbol id
  to:   SymbolId          // callee symbol id (never null)
  via:  "call"            // matches Dependency.via enum in ir-schema §11.1
  confidence: Confidence  // same enum as Symbol; the resolution confidence
  line: number            // caller site (from Call.line)
}
```

A call with `resolved: null` produces **no edge** — the graph is built only from resolved calls. Effect propagation ([`effect-propagation.md`](./effect-propagation.md)) and Slice View ([`slice-view.md`](./slice-view.md)) consume `CallEdge[]` and do not need to inspect `resolved: null` entries themselves.

### 7.2 Confidence propagation

The edge's `confidence` is the resolution confidence at the moment of resolution:

| Resolution path | Edge confidence |
|---|---|
| §4.3 file scope | `high` |
| §4.4 import scope | `high` |
| §4.5 component scope (unique) | `medium` |
| §4.6 workspace scope (unique) | `low` |
| §4.7.1 declared receiver type | `medium` |
| §4.7.1 `super(…)`, `super.<member>`, the classes it extends walked included | `high`: `super` reads the prototype of the class the caller's class extends, which no subclass's override replaces, unlike `this` in §5.2's walked hierarchy |
| §5.2 LSP `this`/`super` direct | `high` |
| §5.2 LSP walked hierarchy | `medium` |
| §5.3 LSP interface with single impl (planned) | `medium` |
| §5.3 LSP interface with DI-resolved impl (planned, §7.4) | `medium` |

Effect propagation must respect edge confidence when combining propagated effect confidence — see [`effect-propagation.md`](./effect-propagation.md) §5.3.

### 7.3 Cross-language edges

An edge whose `from` and `to` differ in the `<language>:` prefix is a **cross-language call**. The untyped tier of this document does not resolve cross-language calls; they are the concern of `multi-language-id.md` (Later phase). Until that design lands, the resolver emits `null` for any candidate whose only match crosses language boundaries.

### 7.4 Framework-plugin hook (planned)

> **Status**: not implemented. No plugin interface in `@aburi/types` declares `resolveDispatch` and the core asks no plugin; an interface-typed call stays `null` (§5.3, itself planned). The design below is what the hook will be.

For §5.3, framework plugins may register a `resolveDispatch(interfaceName, callerComponent) → SymbolId | null` hook. When registered:
- The core queries plugins in config order; first non-null wins (same convention as effect plugins per [`effect-plugin.md`](./effect-plugin.md) §5.1).
- Absent any registration, §5.3's ambiguity rule applies (single impl auto-resolves; multiple leaves `null`).

This hook is the seam through which NestJS provider wiring / React Context providers / Angular DI can turn interface-typed calls into concrete edges without hardcoding DI knowledge into the core.

## 8. Failure Modes and Reporting

Every unresolved call is a **first-class outcome**, not a warning. Consumers must never assume `resolved != null`.

### 8.1 Classification of `resolved: null`

The core does not persist a "why null" reason field on `Call` in the IR. Adding an optional field is non-breaking under [`ir-schema.md`](./ir-schema.md) §15.2, so this is a design choice, not a compatibility constraint: diagnostic buckets are per-run debugging output and belong in logs, not in the fingerprinted IR (they would enlarge every IR document for review value that only matters when investigating a specific resolution outcome). The resolver emits a per-run diagnostic log with buckets:

| Bucket | Meaning | Example |
|---|---|---|
| `local-scope` | resolved to a local variable / parameter | `callback(x)` inside `foo(callback: () => void)` |
| `external` | out of the workspace's reach: bound by an import whose specifier is bare and maps to no file the scan read (§4.4.1) or whose re-exports lead to one (§4.4.2), a leading name nothing around the call declares and no top-level Symbol has, or a member that no Symbol is named and no module exports | `lodash.sortBy(...)`, `setTimeout(...)`, `expect(x).toBe(1)`, `items.map(...)` |
| `dynamic` | receiver is an expression, not a name, or a `this` / `super` receiver with no usable LSP hint and no declared type that resolves it (§4.7.1) | `getRepo().save(...)` where `getRepo` says nothing of what it gives back, `items[0].save(...)` |
| `ambiguous` | multiple candidates | two `User.save` in different components with no explicit import |
| `no-match` | no candidate found, though some Symbol or export bears the name | a member the declaration a call is bound to does not declare while another declaration names one so, or a name the module declares in a scope the resolver does not read. A member missing from a field's declared type is `dynamic` (§4.7.1) |

#### Bucket precedence

A single call can fit several descriptions at once — a parameter that happens to share a name with an imported package, an ambiguous qname reached through an expression receiver. The reviewer needs one stable answer per call site, so the resolver assigns the **most specific cause** in this fixed order:

1. `local-scope` — the §4.2 shadow guard fired, so the resolver never looked outward at all.
2. `external` — no declaration the scan read can be the callee, whatever the receiver holds. That is so in three cases:
   - The head of the target is bound in the caller's file by an import whose specifier is not relative and that §4.4.1 maps to no file the scan read, or by an import whose re-exports lead to such a specifier (§4.4.2). A bare specifier that does map to one is a relative specifier's case, and a miss through it is `no-match`.
   - The language plugin reports that nothing around the call declares the head (`unboundHead`), and no Symbol's qualified name starts with it, read without a trailing `!`. That is a global the runtime or a test runner provides (`setTimeout`, `expect`, `describe`), or a name nothing declares at all. A head of `this`, `super` or `<computed>` is never one, whatever a plugin reports.
   - The target is qualified, and its last segment, read without a trailing `!`, is the last segment of no Symbol's qualified name, dropped Symbols included, nor a name any module exports or re-exports. `items.map()` and `this.emit()` in a class extending a package's `EventEmitter` call members of values the workspace does not define, whatever those values are. A computed segment (`<computed>`) names nothing and is never counted here, nor are `call` and `apply`, through which a function runs itself (`main.call(null)`). `bind` runs nothing, so `main.bind(this)` is counted.

   The test reads names, not declarations: a member a workspace file assigns in a constructor without declaring it as a Symbol is counted here as well, as hono's `app.on` is. It runs before `dynamic` and `ambiguous` because neither a receiver the resolver could name nor a choice between candidates would reach a callee no declaration has. A call that moves here from `ambiguous` carries no candidates.
3. `dynamic` — the receiver is not a name: an expression receiver reported by the language plugin — which includes a property addressed through brackets with something that is not a name, `items[0].save()` ([`lang-plugin.md`](./lang-plugin.md) §4.4) — or `this` / `super` with no declared type that resolves the call (§4.7.1) and no *usable* LSP hint (§4.7) — no hint at all, or one the LSP tier declined (§5.2). `this.save()` is filed here because in the untyped tier the receiver's identity is a runtime property of the class hierarchy, as it is for `getRepo().save()` where `getRepo` says nothing of what it gives back; there is no name for the resolver to look up. The bucket therefore does not separate a call site the type layer never spoke about from one whose hint was refused; `stats.lspEnrichment.hintsRejected` ([`lsp-enrichment.md`](./lsp-enrichment.md) §7.2) is where that distinction is recorded, per run rather than per call site.
4. `ambiguous` — some tier found the callee and refused to choose between candidates (§7.1). The competing Symbol ids are recorded, deduplicated and lex-sorted.
5. `no-match` — nothing matched, though the workspace bears the name somewhere: the search ended at the declaration the head is bound to, which lacks the member (§4.3, §4.4), or at a module that does not export the name.

Where another section files a call under `dynamic`, `ambiguous` or `no-match`, that holds for a call none of the three `external` cases covers; one they cover is `external` whatever else is true of it.

The order is part of the contract: changing it would move counts between buckets on an unchanged workspace.

The buckets also give the census a second denominator. `external` holds the calls whose callee, by the names the scan read, is no declaration of the workspace, so `resolvedCalls / (totalCalls − external)` is the share of the other calls, the ones that could reach workspace code, that do. Because the test reads names, the rate is an estimate: a member assigned without a Symbol, and an import of a workspace package's subpath §4.4.1 maps to no file, leave calls out of the denominator that do reach the workspace, and a call through a parameter or a local, `local-scope` first, stays in it though no declaration names its member (`items.map()`). The public-repository benchmark reports it beside the plain rate.

**A call an effect plugin claimed is in no bucket at all**, whichever description fits it. Such a
call never reaches `calls[]` ([`ir-schema.md`](./ir-schema.md) §9.3), so the resolver never sees
it and `stats.callResolution` never counts it — `prisma[model].create()` is recorded as a
`db.write` whose `effects[].target` carries the computed segment, at the tier the plugin chose,
and that pair is the whole record of what the source computed. The bucket is for the calls that
stay calls.

#### Where the counts and the detail live

Aggregate counts go to `IR.stats.callResolution` ([`ir-schema.md`](./ir-schema.md) §12), an optional object added additively under §15.2:

```jsonc
"callResolution": {
  "totalCalls": 1310,     // call sites in Symbol.calls[] across all kept Symbols
  "resolvedCalls": 1203,  // Call.resolved != null
  "unresolved": {         // sums to totalCalls - resolvedCalls
    "localScope": 2, "external": 30, "dynamic": 60, "ambiguous": 3, "noMatch": 12
  }
}
```

Property names are the camelCase spelling of the kebab-case bucket ids above (`local-scope` → `localScope`, `no-match` → `noMatch`). Calls promoted to `Symbol.effects[]` by an effect plugin, and calls removed by Category C drop rules, never reach `calls[]` and are therefore not counted. Integrity invariant #15 ([`ir-schema.md`](./ir-schema.md) §14) re-derives all three numbers from `symbols[]` so the census cannot drift from the document it describes.

When the scan marked a generated file ([`ir-schema.md`](./ir-schema.md) §5.9), the object also holds `generated`: the same three numbers over the calls of the marked Symbols alone. They are resolved exactly as every other call is, and they stay in the counts above, which a reader written before the block keeps reading; what changes is what a reader reports as the workspace's own rate. A build script's output can hold more calls than the code around it — one registry of `React.lazy` loaders held 15,485, none resolvable — and counted as authored code it decides the number: `aburi scan` and `aburi diff` print the authored census, total less generated, bucket by bucket, and the generated calls after it ([`cli-spec.md`](./cli-spec.md) §6.6).

`aburi scan` and `aburi diff` render the object as one stdout line ([`cli-spec.md`](./cli-spec.md) §6.6), and the Slice View projection marks the affected members ([`slice-view.md`](./slice-view.md) §12.6) so a reviewer can tell a legitimately disconnected singleton from a resolver miss without a second command.

The per-call detail — which line, which bucket, which candidates — is **not** persisted. It travels in memory on `ScanResult.unresolvedCalls` and is rendered per Symbol by `aburi explain --debug-resolution`. Because the IR cannot carry it, that flag always rescans the workspace and refuses to combine with `--no-rescan` or `--ir`.

### 8.2 Determinism under partial failures

- LSP timeout on a specific call → that call falls back to the untyped tier's answer. It does not degrade any other call site's confidence.
- Missing `symbolTable` entry for an imported file (e.g. `.d.ts` intentionally not scanned) → for a relative specifier, `resolved` stays `null` and the call is bucketed `no-match`; a bare specifier is external. Confidence `high` on the negative result. Either way, a qualified target through a named import that keeps the exported name is still looked up at Steps 4–5 first (§4.4).
- Cycle in imports → does not affect resolution (resolution is per-call, not transitive).

### 8.3 Non-goals

Explicitly out of scope:

- **Renaming a resolved id after the fact.** The first matching Symbol id wins; if that Symbol hands on another value (`export const Invoice = InvoiceImpl`), the edge points at that Symbol, not at what its value came from, since a `const` is a declaration and reading its initialiser is evaluating it. A re-export clause (`export { Invoice } from './invoice'`) is no Symbol at all, and is followed to the declaration before any id is chosen (§4.4.2, §11.6).
- **Adding a distinction beyond what the qname convention already carries.** [`ir-schema.md`](./ir-schema.md) §3.2 distinguishes instance vs. static members at the qname level (`ClassName.method` vs. `ClassName::method`). A call through the class name reads the static side, which is the one step §4.3 takes to compose `::`; nothing else is layered on top: whatever the language plugin's qname says is the identity of the callee, that is the identity used in `resolved`.
- **Confidence numbers.** Categorical only, per [`overview.md`](./overview.md) §2.

## 9. Determinism Guarantees

The resolver's output is a pure function of its inputs. Given the same `symbolTable`, same `importTable`, same `declaredReceiverTypes`, same `returnSources` and `receiverCalls`, same `receiverTypes` (or an empty LSP layer), the same `(Symbol, Call)` pair produces the same `resolved` and same confidence, **byte-for-byte**.

- No timestamps, no random tiebreaks, no dependence on OS filesystem enumeration order.
- Multi-candidate tiebreak is lexicographic on Symbol id (§5.5).
- Parallel resolution across files is allowed but the final `calls[]` array in each Symbol is re-sorted per [`ir-schema.md`](./ir-schema.md) §1 (ascending by `line`) before IR emission.

Time-series diff stability follows directly: adding a call in file A never changes the resolution of an existing call in file B.

## 10. Verifiable Properties (Test Criteria)

Every implementation of the resolver must pass the following.

### 10.1 Untyped-tier resolution

| ID | Input | Expected |
|---|---|---|
| CR1 | same-file top-level function call (`foo()`) | `resolved` = same-file Symbol id, confidence `high` |
| CR2 | named-import call (`import { X } from './y'; X()`) | `resolved` = `<lang>:./y#X`, confidence `high` |
| CR2a | named-import call through an emitted extension (`import { X } from './y.js'`, `'./y.mjs'`, `'./y/index.js'`) with `y.ts` / `y.mts` / `y/index.ts` in the workspace | `resolved` = the TypeScript source's Symbol id, confidence `high`; a `y.ts` beside a `y.js` wins |
| CR2b | named-import call through a directory specifier (`'.'`, `'..'`, or any whose last segment is empty, `.` or `..`, such as `'./'`, `'../'`, `'./y/..'`) | `resolved` = that directory's `index.<ext>` Symbol id, confidence `high`; a sibling `<dir>.<ext>` is never probed, nor the directory's `package.json#main`, which TypeScript consults before `index` (§4.4.1); a `..` that climbs above the workspace root resolves to nothing rather than to the root index, and a miss is bucketed `no-match`, not `external`, as for any relative specifier |
| CR2c | a call through a barrel that re-exports the callee, imported by name, alias, default or namespace — `export { X } from './x'`, `export { Y as X } from './x'`, `import { X } from './x'` with `export { X }`, `export { default as X } from './x'`, `export * from './x'` — through a chain of barrels and relative or mapped specifiers | `resolved` = the declaration's Symbol id, confidence `high`; a dotted tail composes past it (`X.run()` reaches `X::run`), and through `export * as ns from './x'`, `ns.f()` reaches `./x#f` |
| CR2d | two `export * from` whose modules both export the name, declared apart or one of them as a namespace, a barrel re-exporting the name from them included | `resolved` = `null`, diagnostic bucket `ambiguous`, every declaration recorded; for a dotted call (`X.run()`) too, whether one, both or neither declares `run` |
| CR2e | a chain that reaches a bare specifier mapping to no workspace file — `export { sortBy } from 'lodash'`, or `export * from 'lodash'` with no other star export answering | `resolved` = `null`, diagnostic bucket `external` |
| CR2f | barrels re-exporting the name from each other, a re-export through a relative specifier naming no file, a module no edge of which exports the name, `export type * from` and a type-only re-export | the chain ends with no answer: a bare call is `no-match`, and a qualified one through a named import keeping the exported name goes on to Steps 4–5 (CR11) |
| CR2h | a call through an import of a name an export clause gives a declaration of the module — `function stringType() {}` with `export { stringType as string }` in `./y`; `import { string } from './y'`, `import { string as s } from './y'`, `import * as y from './y'; y.string()`, and `class Impl {}` with `export { Impl as Service }`; `Service.make()` | `resolved` = `<lang>:./y#stringType`, and `<lang>:./y#Impl::make`, confidence `high`, also where the module declares a `string` of its own, which it then does not export under that name. `null` where a drop rule removed `stringType`, rather than the namesake |
| CR2g | a barrel re-exporting a class that lacks the member (`Logger.log()` through `./barrel`, `Logger` declared in `./logger` with no `log`) while another file declares a `Logger.log` | `resolved` = `null`, diagnostic bucket `no-match`; Steps 4–5 are not searched (CR11a) |
| CR3 | aliased named-import (`import { X as A } from './y'; A()`) | `resolved` = `<lang>:./y#X`, confidence `high` |
| CR4 | namespace import (`import * as N from './y'; N.foo()`) | `resolved` = `<lang>:./y#foo`, confidence `high` |
| CR5 | default import of an anonymous default export (`export default () => …` in `./y`; `import D from './y'; D()`) | `resolved` = `<lang>:./y#<default>`, confidence `high` |
| CR5a | default import of a named default export under another local name (`export default function makeApp() {}` in `./y`; `import createApp from './y'; createApp()`), including one declared apart from its export (`const f = …; export default f`) and one an export clause makes the default (`function connect() {}; export { connect as default }`) | `resolved` = the declaration's Symbol id (`<lang>:./y#makeApp`, `<lang>:./y#f`, `<lang>:./y#connect`), confidence `high` |
| CR5b | dotted call through a default import (`export default class Svc { static run() {} }` in `./y`; `import S from './y'; S.run()`) | `resolved` = `<lang>:./y#Svc::run`, confidence `high`: the tail composes past the default export's own name as §4.3 composes it |
| CR5c | default import whose local name is also a named export of the module (`import connect from './y'` where `./y` has `export function connect`) | the named export is never taken: `resolved` = the module's default export when it has one (CR5, CR5a), and `null`, bucketed `no-match`, when it has none |
| CR5d | default import of a module with two default exports (TS2528) | `resolved` = `null`, diagnostic bucket `ambiguous`, both candidates recorded; for a dotted call through it (`U.save()`) whose member both declare, too, rather than a same-named `U.save` elsewhere (CR11a) |
| CR5e | default import of a default export written as a call (`export default withAuth(async (req) => { … })` or `export default withAuth(Page)` in `./y`; `import handler from './y'; handler(r)`) | `resolved` = `<lang>:./y#<default>`, confidence `high`, as CR5 |
| CR6 | type-only import used as call — cannot happen at runtime but resolver sees the string | `resolved` = `null`, confidence `high` |
| CR7 | bare specifier (`import { sortBy } from 'lodash'; sortBy()`), and a qualified call through a named import of a package outside the workspace (`import { Logger } from '@nestjs/common'; Logger.log()`) while the workspace declares a `Logger.log`, with a `baseUrl` that maps the specifier to no file the scan read or without one | `resolved` = `null`, confidence `high`, bucketed `external`; Steps 4–5 are not searched. Through a workspace package's name that maps to no file the scan read, the qualified call goes on to them (CR7b) |
| CR7a | bare specifier a `tsconfig.json` path alias maps to a workspace file (`"paths": { "@app/billing": ["libs/billing/src/index.ts"] }`; `import { formatInvoice } from '@app/billing'; formatInvoice()`), a named, aliased or namespace import, a mapping to a directory or an extensionless path; and a class, a variable's type or a function's return type a file that makes no call imports through such an alias (CR14d, CR14f, CR14g) | `resolved` = `<lang>:libs/billing/src/index.ts#formatInvoice`, confidence `high`; a name the file does not declare is `null`, bucketed `no-match`. A mapping to no file the scan read leaves CR7's answer. Each type binds where its file imports it, so the calls resolve as CR14d, CR14f and CR14g resolve them through a relative import |
| CR7b | a workspace package's name, or a subpath under it, that no `paths` key maps — `import { sortBy } from '@acme/kit'` with `"exports": { ".": { "import": "./dist/index.js", "source": "./src/index.ts" } }`, `"main": "./index.js"`, `"exports": { "./lib/*": "./src/lib/*.ts" }` | `resolved` = the declaration in the file the manifest names that the scan read, through its re-exports (§4.4.2), confidence `high`; a name it does not export is `null`, bucketed `no-match`. A name that only shares a prefix with a workspace package's, a name two workspace manifests share, and a manifest naming only files the scan did not read, leave CR7's answer |
| CR8 | dynamic import (`await import('./y')`) — no direct call at the site | no `Call` entry, no edge |
| CR9 | call to a parameter (`function f(cb) { cb() }`) | `resolved` = `null`, confidence `high` (local shadow) |
| CR9a | call to a name a destructuring parameter binds (`{ x }`, `[x]`, `{ a: x }`, `{ x = y }`, `...[x]`) | `resolved` = `null`, confidence `high` (local shadow); a call to `y` in `{ x = y }` is not shadowed. A single-name rest parameter (`...x`) is CR9's case: its `name` is `x`. Through a function a `const` or a class field hands its call (`const h = withAuth(({ x }) => x())`, LP7c; `class C { h = withAuth(({ x }) => x()) }`, LP20f1), whose parameters are on no `signature`, the call is CR10's |
| CR10 | call to a name a scope inside the caller declares, which the language plugin marks `localHead`: a nested function, a `const` or `let` of the body, a block's binding, a `for…of` or `catch` binding, a callback's parameter (`list.forEach((save) => save())`), while the file declares or imports a function of the same name (`import { deleteUser } from './users'; const deleteUser = (x) => log(x); deleteUser(id)`) | `resolved` = `null`, confidence `high`, bucketed `local-scope`, and none of the namesake's effects propagate to the caller. A type the local is declared with still resolves the call (CR14c). A class declaration's own name inside its body is the module's class (`class Repo { m() { Repo.make() } }` reaches `Repo::make`) |
| CR11 | qualified cross-file same-component (`PricingService.calc()` no import) | `resolved` = that Symbol id when unique, confidence `medium` |
| CR11a | qualified target whose head is bound to a declaration without the member, while other files declare a member of that name (`Logger.log`), in the caller's component or another. The declaration is a class, enum, namespace or object-literal `const`, kept or dropped, that the caller's file declares or that a named import keeping the exported name reaches in a module declaring it. Or the head is bound by an aliased, default or namespace import, whatever its module declares | `resolved` = `null`, diagnostic bucket `no-match` (`external` for a bare specifier, `ambiguous` with CR5d's candidates); Steps 4–5 are not searched. With the member declared, `resolved` = that member, confidence `high`. CR11 / CR12 are still reached for a head bound by nothing, by an `ambient-declaration`, a `destructured-binding`, a function or a `const` whose value the resolver cannot see, or by a named import keeping the exported name of a workspace package's name that maps to no file the scan read, of a module the scan has no Symbol in, or of a module whose re-exports lead to no declaration of it. A named import of any other bare specifier is CR7's |
| CR12 | qualified workspace-scope (no import, unique globally) | `resolved` = that Symbol id, confidence `low` |
| CR13 | ambiguous qualified name (two matches) | `resolved` = `null`, confidence `medium` |
| CR14 | `this.<method>` in untyped mode, where the class inherits the method from no class §4.7.1 rule 2 reaches (`extends Mixin(Base)`, a class of a package the scan did not read), the caller is a static member, the class is a class expression or anonymous, or a function or namespace declares it | `resolved` = `null`, confidence `medium`, bucketed `dynamic` |
| CR14b | `this.find()` in an instance member of `class UserService`, which declares `find` as a method or a field's function, and `this.load()`, which it inherits from a `class Base` its file declares or imports, in untyped mode | `resolved` = `UserService.find` and `Base.load`, confidence `medium`. With an LSP hint for the call, the hint's Symbol, confidence `high` (CR16); a hint the resolver declines leaves `UserService.find` |
| CR14a | `this.repo.find()` beside `constructor(private readonly repo: UserRepository)`, the class imported or declared in the caller's file, in untyped mode | `resolved` = `UserRepository.find`, the instance member, confidence `medium`, the same with an LSP hint for the call, which is not read. `null`, bucketed `dynamic`, when the type is an interface, when neither the class nor a class it extends declares `find` (CR14d), when the file binds no such name, though another file declares the class, when it reaches the class only through a package name that maps to no workspace file or a barrel whose re-exports do not reach it, for an unannotated or inherited field, but a `readonly` one constructed from the class (`private readonly repo = new UserRepository()`), which resolves as one typed with it, one typed with a union of two types, and when the calls sharing the key (Symbol, line, target) do not all name one type. A field typed `UserRepository \| null` resolves as one typed `UserRepository` does |
| CR14c | `repo.find()` beside a parameter `repo: UserRepository`, `const repo = new UserRepository()` in the module or in the caller, or `let repo: UserRepository \| null`, and `new UserRepository().find()`, the class imported or declared in the caller's file, in untyped mode | `resolved` = `UserRepository.find`, confidence `medium`. `null`, keeping the bucket steps 1–5 give it, when a nested scope around the call declares `repo` again without a type, when `repo` is a `let` constructed from the class, an import, destructured or untyped, when the type is a union of two types or an interface, and when neither the class nor a class it extends declares `find` (CR14d) |
| CR14d | `repo.find()` beside `repo: AdminRepository`, `this.repo.find()` beside a field of that type, or `this.find()` in a member of `AdminRepository`, where `AdminRepository extends Repository`, directly or through classes between them, `Repository` declared or imported in the file that declares the class that extends it and not in the caller's, and only `Repository` declares `find`, in untyped mode | `resolved` = `Repository.find`, confidence `medium`; the nearest class that declares `find` when several up the chain do. The same through a class between them, or `AdminRepository` itself, that a drop rule removed, as a subclass that only adds fields is, and past a field that only narrows the member's type (`find!: Repository["find"]`). `null`, bucketed as CR14, CR14a and CR14c bucket them, when `AdminRepository` declares a `find` a drop rule removed or one that has no Symbol (`find = make()`, `constructor(public find: Finder)`, `this.find = …` in its constructor or a method), when its `extends` names a class only the caller's file binds, a function, or a call (`extends Mixin(Repository)`), and for classes that extend one another in a cycle |
| CR14e | `super(…)` in the constructor and `super.find()` in an instance member of `class AdminService extends BaseService`, `BaseService` declared or imported in the caller's file, which declares `find` or inherits it from a class it extends (CR14d), in untyped mode | `resolved` = the class `BaseService` and `BaseService.find`, the nearest class up the chain that declares `find`, confidence `high`. `null`, bucketed `dynamic`, when `BaseService` binds no class, or a class a drop rule removed for `super(…)`, when the class that declares `find` holds it in a field (`find = () => …`), declares a `find` a drop rule removed or one that has no Symbol, for `super.repo.save()`, in a static member, and when the class extends a call (`extends Mixin(BaseService)`) |
| CR14f | `onlineManager.setOnline()` through `import { onlineManager } from "./onlineManager"`, an alias, a namespace import (`managers.onlineManager.setOnline()`) or a barrel, where that module declares `export const onlineManager = new OnlineManager()` or `export let onlineManager: OnlineManager \| null`, `OnlineManager` declared or imported in that module, in untyped mode | `resolved` = `OnlineManager.setOnline`, or the member a class it extends declares (CR14d), confidence `medium`, through a variable a drop rule removed too. `null`, keeping the bucket steps 1–5 give it, when the module names no type for the variable (`export const onlineManager = make()`, a `let` constructed from the class), when the type binds no class in that module, though the caller's file imports one of that name, when neither the class nor a class it extends declares the member, and when a local of the caller's hides the import (a callback's parameter, a block's `const`, a `for…of` or `catch` binding, a destructured `const`, a parameter), for which the language plugin marks no `importedReceiver` |
| CR14g | `getRepo().find()`, `const repo = getRepo()` then `repo.find()`, and `builder().with(1).find()`, where `getRepo` is declared `getRepo(): UserRepository` or returns `new UserRepository()`, a typed name, or a call of a function that does; where it is a `const` holding such a function by name; and where `with` returns `this` in `UserRepository`, which `builder()` gives back, the class bound in the file that declares the callee, in untyped mode | `resolved` = `UserRepository.find`, or the member a class it extends declares (CR14d), confidence `medium`. Through a `with` that returns `this` (`: this`, or `this` on every path), the class is the receiver's: `sub.with(1).find()` with `sub: Sub` and `new Sub().with(1).find()` reach `Sub.find` where `Sub extends UserRepository` overrides `find`. `null`, keeping the bucket steps 1–5 give it, when the receiver's call is unresolved or resolves only at `low` confidence, when the callee is `async`, a generator or an accessor, names nothing it gives back, or names a type it binds to no class though the caller's file imports one of that name, when two calls written alike on one line could each be the receiver's, when what the callee gives back comes round to itself, when neither the class nor a class it extends declares the member, and when the receiver is a `let`, an annotated `const` or awaited |
| CR15 | `new <ClassName>()` where class is imported | `resolved` = the class Symbol id, confidence `high` |

### 10.2 LSP-tier resolution

| ID | Input | Expected |
|---|---|---|
| CR16 | `this.foo()` in class C with method `foo` | `resolved` = `C.foo`, confidence `high` |
| CR17 | `this.foo()` inherited from parent class B | `resolved` = `B.foo`, confidence `medium` |
| CR18 | `super.foo()` | `resolved` = parent's `foo` Symbol, confidence `high` |
| CR19 | interface-typed receiver with single implementer (planned, §5.3) | `resolved` = implementer's method, confidence `medium` |
| CR20 | interface-typed receiver with multiple implementers, no framework hook | `resolved` = `null` |
| CR21 | interface-typed receiver, framework plugin's `resolveDispatch` returns a Symbol id (planned, §7.4) | `resolved` = that id, confidence `medium` |
| CR22 | untyped tier already resolved → LSP tier leaves it alone | unchanged |

### 10.3 Determinism

| ID | Input | Expected |
|---|---|---|
| CR23 | resolve the same fixture twice | byte-identical `calls[]` output |
| CR24 | resolve with parallel workers = 1 vs. 4 | byte-identical `calls[]` output |
| CR25 | LSP server returns candidates in reverse order between two runs | byte-identical `resolved` (tiebreak wins) |
| CR26 | add an unrelated file elsewhere in the workspace | existing Symbols' `resolved` values unchanged (locality) |

### 10.4 Failure classification

| ID | Input | Expected |
|---|---|---|
| CR27 | `factory().save()`, where `factory` says nothing of what it gives back and some Symbol's qualified name ends in `save` | `resolved` = `null`, diagnostic bucket `dynamic`. With no `save` named anywhere it is CR31's case |
| CR28 | a named import of a name its relative module does not declare (`import { foo } from './y'; foo()`) | `resolved` = `null`, diagnostic bucket `no-match`. A typo nothing declares (`foo()` where no `foo` exists) is CR30's case |
| CR29 | ambiguous cross-component qname | diagnostic bucket `ambiguous`, candidates recorded |
| CR30 | `setTimeout(...)`, `expect(x).toBe(1)`, `describe(...)`, `require("x")` where nothing around the call declares the head and no Symbol's qualified name starts with it | `resolved` = `null`, diagnostic bucket `external`. A head a top-level Symbol has, `helper!()` included, and a head of `this` or `super` a plugin marks stay out of `external` |
| CR31 | `items.map(...)`, `items.map!(...)`, `this.emit(...)` in a class extending a package's class, `main.bind(this)`, where no Symbol's qualified name ends in the member and no module exports it | `resolved` = `null`, diagnostic bucket `external`, ahead of `dynamic` and `ambiguous`; a parameter's or a local's member stays `local-scope`. A member a Symbol of any class is named, kept or dropped, a name an export clause or a re-export gives, a computed member, and `call` and `apply` stay out of `external` |

## 11. Design Decisions

### 11.1 Why five ordered steps instead of one graph search

A single "search everything" pass mixes strong and weak evidence. Splitting into ordered steps gives each step a **defensible confidence**: file / import matches are `high`, component scope is `medium`, workspace scope is `low`. Downstream consumers (effect propagation, Slice View) can then choose which confidence tier they trust.

### 11.2 Why untyped resolution ships before LSP

`overview.md` §2 rejects LSP-only for CI stability reasons. If the graph existed only when LSP was up, the Slice View and effect propagation would be unusable in the default `aburi scan` / `aburi diff` invocation. The untyped tier gives a usable graph for the common case (same-file, imported cross-file, qualified references) and LSP refines the residual.

### 11.3 Why local-scope callables produce `null` and not a synthetic Symbol id

Introducing anonymous Symbol ids (`<caller>#local:cb`) would clash with [`ir-schema.md`](./ir-schema.md) §3.3, which forbids anonymous Symbols from becoming independent entries. Emitting `null` keeps the IR schema honest and pushes the "runtime data" fact upstream where it belongs.

### 11.4 Why the resolver runs in `@aburi/core`, not in the language plugin

Resolution requires knowledge of every file's imports and every Symbol in the workspace. Only the core has that view; the language plugin operates one file at a time. Keeping resolution in the core also lets it be shared across languages (§7.3) once cross-language resolution is designed.

### 11.5 Why confidence is per-edge, not per-Symbol

An edge from A to B is a distinct fact from A's own confidence. Downgrading A's `confidence` because one of its outgoing edges is `low` would be a category error. Effect propagation is where the two confidences combine — see [`effect-propagation.md`](./effect-propagation.md) §5.3.

### 11.6 Why re-exports are followed

A barrel file `packages/domain/index.ts` re-exporting `export { Invoice } from './invoice'`, or `export * from './invoice'`, declares no `Invoice`: a re-export is not a declaration, so the barrel has no Symbol of that name. Most packages are entered through one, so an import scope that stopped at the barrel left most calls into a package without an edge, or with the `medium` or `low` one Steps 4–5 give for a target that happens to spell a unique name — and none for a bare call, a namespace import or an alias, which they never match.

Following a re-export needs the module's own edges, which the scan has for every file before the resolver runs, and nothing else. So the chain is a function of the edge table and the Symbol table, as the rest of the resolver is (§9), not of the order the files were read: a module visited twice for one name ends the chain, and star exports are all asked before one is chosen. What it costs is bounded the same way: a search asks each (module, name) pair once, however many paths of star exports lead to it, and keeps the answer of every pair no cycle cut short for the searches after it.

The answer is the declaration TypeScript binds, at `high`. Where TypeScript would not bind one — two star exports that disagree — the resolver does not choose either. Where the chain leaves the workspace, the call is the external one its first bare specifier names, which is what a reviewer reading the barrel finds too.

### 11.7 Why an unresolvable call is high-confidence

`resolved = null` with `confidence = high` is the honest description of "this call is genuinely a runtime dispatch or an external library". It is not a guess. The framework/effect classification path is what carries the actual semantics (`db.write` etc.); the graph edge is only there when both endpoints are workspace Symbols. Treating "no edge" as a first-class high-confidence outcome removes the temptation to fabricate weak edges just to make the graph denser.
