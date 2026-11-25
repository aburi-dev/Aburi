# Effect Plugin Interface

Definition of the plugin interface for classifying call_expressions as side effects (effects).
One effect plugin is responsible for one library/framework domain (e.g. Prisma / NestJS / Stripe / Redis).

References:
- [`ir-schema.md`](./ir-schema.md) §9 — Effect structure
- [`extension-vocab.md`](./extension-vocab.md) — Effect ids (`x-<plugin>:<action>`) and the manifest
- [`lang-plugin.md`](./lang-plugin.md) §5.1 — cooperation points with language plugins
- [`drop-list.md`](./drop-list.md) §5.2 — when an effect plugin adds loggers etc. to the drop targets

---

## 1. Purpose

From the textual form of a call_expression (`prisma.invoice.create`) and its surrounding context, determine what effect the call represents (`db.write` / `x-stripe:charge`, etc.).

The language plugin only provides "what was called" at the string level. The effect plugin determines "what it means" in a language-independent way.

## 2. Plugin Responsibilities

### 2.1 In scope

- Declare effect ids (individual / prefix) in the manifest
- Receive a `CallCandidate` and determine whether it is an effect this plugin recognizes
- If recognized, return an `EffectClassification` (effectId / confidence / derivedBy)
- If recognized but not classifiable from the call site, return an `EffectDecline` naming the reason (§4.5)
- If not recognized, return `null`
- Optionally, add calls this plugin recognizes to drop-list category C (logger-oriented effect plugins only)

### 2.2 Out of scope

- Parsing sources (the language plugin's job)
- Walking the AST
- Creating or modifying Symbols themselves
- Overriding results classified by other plugins
- Writing directly to `Symbol.derivedBy[]` (only returns a per-effect `derivedBy`)
- Applying config.suppress / keep (the core)

The responsibility is confined to a pure function "callee → effect classification". As a result:
- Effect plugins reduce to almost purely declarative pattern matching
- Unit testing is easy (feed a callee string and assert the expected effectId)
- They are reusable across languages (the same Prisma plugin is expected to work for TS and Python alike)

## 3. Lifecycle

```
1. The registry validates the manifest and loads the plugin
2. plugin.init(ctx) is called, once per scan, before the scan's first plugin call
3. Each time a language plugin extracts CallCandidate[] in walkBody:
     for each call, the enabled effect plugins are invoked in config order
       plugin.classify(call, ctx) → EffectClassification | EffectDecline | null
     the first classification is adopted; a call none classifies keeps its declines (§5)
4. After the scan's last plugin call, plugin.cleanup?() is called
```

The order of the calls, and what a failing `init` or `cleanup` does, are the language plugin's
([`lang-plugin.md`](./lang-plugin.md) §3).

## 4. Interface

The actual types are defined in `@aburi/types`. This document shows the signatures of the contract surface.

### 4.1 `EffectPlugin`

```ts
interface EffectPlugin {
  manifest: PluginManifest                   // type: "effects"
  init?(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // effect classification (ideally implemented as a pure function)
  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null

  // optional: additions to drop-list category C (implemented by logger-oriented plugins only)
  dropCallees?: string[]                     // identifier path prefixes (e.g. "pino", "winston")
}
```

### 4.2 `CallCandidate` (from the language plugin)

Normatively defined in [`lang-plugin.md`](./lang-plugin.md) §4.4. This document only references the same type.
Summary: the 6 fields `{ target, line, argumentCount, inAwait, inNew, literalArgs }`, and three optional ones, `dynamicReceiver`, `receiverType` and `thisBinding`. `literalArgs` covers cases such as wanting to inspect the contents of an SQL string (non-literals are `null`). `receiverType` is the named type the receiver is declared with, when the language plugin can read one (§5.4).

`target` is contract-guaranteed non-empty with no empty segments, and an `ImportEdge`'s `source`, `symbols` entries and `namespaceBinding` are non-empty too (lang-plugin.md §4.4, "Normalized-callee contract"). Effect plugins enforce that contract instead of coding around it, through the guards in `@aburi/plugin-registry/plugin-input`. Each throws a `PluginInputError` under its own code:

- `assertNonEmptySegments` splits `target` into its segments, and raises `unnormalized-callee` when the target or a segment is empty.
- `assertImportEdgeSource` raises `unnormalized-import-source` for an empty `ImportEdge.source`. `hasMatchingImport` runs it over every edge before matching a module specifier.
- `assertImportBinding` raises `unnormalized-import-binding` for an `ImportEdge.symbols` entry with an empty half.
- `assertNamespaceBinding` raises `unnormalized-namespace-binding` for an empty `ImportEdge.namespaceBinding`.

The error names the plugin and the file, so a consumer branches on `code`, as it does on the core's and the registry's errors, without reading the message. The guards live in the registry rather than in each plugin so the next effect plugin inherits identical codes, identical messages and identical fail-fast ordering. They ship as a dedicated subpath so importing them does not pull the registry's manifest validator (and its schema compilation) into a classifier's startup path.

A violation raised by these guards is **not** a classification outcome, so it is exempt from the EP3 degradation in §10: a classifier that throws while deciding is a plugin bug the run can absorb by treating the call as unclassified, whereas an unnormalized callee means every downstream classification of that file was computed from a value the pipeline promised could not exist. Degrading it to `null` would turn an upstream parser bug into a quietly under-populated IR — the one outcome the guards exist to prevent. See EP3a.

What the throw costs is the **file**, not the run: the core's per-file boundary (lang-plugin.md §7.2) withdraws it, names it in `ScanResult.skipped` and in `ScanResult.extractionFailures` under the guard's code, logs a warning, and makes `aburi scan` exit non-zero. That is not the degradation this section rules out — a degraded call is silent and a withdrawn file is counted, named, and quoted back with what the guard said.

### 4.3 `ClassifyContext`

```ts
interface ClassifyContext {
  owner: OwnerSummary                        // summary of the Symbol containing the call
  file: FileSummary                          // file information (including imports)
  language: string                           // "ts" / "py" / "rs" etc.
  registry: VocabRegistry
  config: Config
}

interface OwnerSummary {
  id: string                                 // id of the owning Symbol
  kind: SymbolKind
  name: string
  extKind: string | null                     // value already determined by the framework plugin
  decorators: OwnerDecorator[]
  component: string | null
}

type OwnerDecorator = Pick<Decorator, 'name' | 'qualifier' | 'boundary'>

interface FileSummary {
  path: string
  imports: ImportEdge[]                      // the file's imports, with `upstream` where the scan followed them
}
```

Providing `imports` lets the effect plugin distinguish whether "the identifier `prisma` comes from `@prisma/client` or is a local homegrown variable".

A client is usually built in one module and used from others: `import { prisma } from "./lib/db"`, or `constructor(private prisma: PrismaService)` beside the service that extends `PrismaClient`. The file using it imports nothing from the library, so the edges an effect plugin is handed carry `ImportEdge.upstream` (lang-plugin.md §4.2, followed as §5.1 says) on every edge whose module is in the workspace: for each name the edge binds, the specifiers of the imports the module declaring it makes, followed through re-exports and the `export *` targets that export the name, and the name's `origins` entry where the chain ends at a package. `importGate` in `@aburi/plugin-registry/plugin-input` reads them for a call's leading name. The import that binds that name decides first wherever the scan followed it, and only a leading name no import binds (`this`, a parameter, a local), or one bound by an import the scan could not follow (of another package, or of a module it could not read), falls back to the file's imports as a whole:

| the import binding the leading name | the file's imports, where no followed import binds it | gate |
|---|---|---|
| imports the name from the library, or its `origins` entry ends there | import the library | `direct` |
| imports it from a workspace module whose `upstream` for the name includes the library | — | `bound` |
| — | only lead to the library through a name they bind (`PrismaService` beside `this.prisma`) | `reached` |
| its `origins` entry ends at another package, or its `upstream` holds no library module | none of the above | `null` |

`bound` and `reached` say less than `direct`: a module the name, or some name the file imports, comes from uses the library, not that the call's receiver is its client. `export const usersRepo = new UsersRepo()` in a module that imports `drizzle-orm` is `bound` for `usersRepo.update(id, dto)`, and is no client. The official plugins classify there only a receiver their client vocabulary names or a type from the library declares (§5.4 item 3), and `effects-trpc`, whose client has no vocabulary of its own, a `direct` or `bound` call only, since a tRPC client is a name imported from where it is built. Because the binding decides first, a type the file imports from the library beside a bound name changes nothing: a client imported from `./lib/db` is classified the same with or without an `import type { User } from "@prisma/client"` beside it, and so are an import of it under a name no vocabulary places and a name a module without the library declares (`import { cache } from "./cache"`). For a leading name no followed import binds, such a type import does make the file `direct`, so `this.store.entries.delete({ key })` is `medium` `db.write` in a file that imports a Prisma type and stays in `calls[]` in one that does not. Framework plugins, the Document and call resolution read the file's own edges: `upstream` is set on the copy effect plugins are handed.

`decorators[].qualifier` is `Decorator.qualifier` (ir-schema.md) passed through: the receiver that `@tsed.Post()` was written through (`tsed`), absent for a bare `@Post()`. Resolving it against `imports` answers the same question for a decorator, by the rule lang-plugin.md §5.2.2 gives: only the first dot-separated segment can name a local binding, so `@a.b.C()` resolves through `a`, and comparing the whole `a.b` with `ImportEdge.namespaceBinding` finds nothing. The other `Decorator` fields (`raw`, `arguments`, `line`) are not passed; a field added to `Decorator` reaches effect plugins only once `OwnerDecorator` names it, and a type test in `@aburi/types` fails `pnpm typecheck` until that is decided (`pnpm test` alone cannot fail it, because `expectTypeOf` erases at runtime).

### 4.4 `EffectClassification`

```ts
interface EffectClassification {
  effectId: string                           // a core id from ir-schema §9.1 or x-<plugin>:<action>
  confidence: 'high' | 'medium' | 'low'      // ir-schema §5.4
  derivedBy: string                          // e.g. "effects-plugin:prisma:create"
}
```

The returned `effectId` must fall under **the manifest's `provides.effects[].id` or `provides.effectPrefixes[]`**. The registry detects violations at extraction time and raises an error.

### 4.5 `EffectDecline`

```ts
interface EffectDecline {
  declined: string                           // e.g. "effects-plugin:trpc:procedure-query"
}
```

`null` says "not mine". A decline says "mine, and I will not say which effect": the call has the library's shape, but the plugin cannot classify it soundly. The official plugins decline three shapes:

| Plugin | Call | `declined` | Why it cannot classify |
|---|---|---|---|
| `effects-trpc` | a call of three or more segments ending in `.query()` whose chain starts from a name that is `procedure` or ends in `Procedure`, or reads `procedure` straight off its root, in a file that imports a tRPC client | `effects-plugin:trpc:procedure-query` | the router's builder (`publicProcedure.input(schema).query(resolver)`) is spelled like a client call (`client.user.byId.query()`), and only its chain tells it apart |
| `effects-prisma` | `$queryRaw`, `$queryRawUnsafe`, `$queryRawTyped`, `$executeRaw`, `$executeRawUnsafe` or `$runCommandRaw` called on a receiver, in a file that imports Prisma | `effects-plugin:prisma:raw-query` | a raw query — SQL, or a MongoDB command for `$runCommandRaw` — can read or write, and the query is not in the callee |
| `effects-drizzle` | `.execute(statement)` with an argument, on a receiver whose name mentions a Drizzle client word (`db`, `tx`, `database`, `conn`, …), matched word-wise as for the confidence tier (§5.4), in a file that imports Drizzle | `effects-plugin:drizzle:raw-sql` | raw SQL can read or write, and the statement is not in the callee |

The tRPC decline is keyed on the call's chain, which its `target` keeps: `publicProcedure.input(schema).query(resolver)` is `publicProcedure.input.query`, and `t.procedure.query(resolver)` reads `procedure` straight off its root. These are the names tRPC's documentation and create-t3-app give a base procedure, and the naming convention `framework-trpc` reads a procedure by, applied here after a leading `this` is stripped: a client reached as `this.trpc…` reads like any other, so `this.adminProcedure.input.query` is declined where `framework-trpc`, which never takes `this` for the instance, reads no procedure. Only a call past the client-import gate and of three or more segments is declined; `protectedProcedure.query(resolver)` has two and is `null`, with no entry. Every other `.query` of three or more segments is a client call whether or not the file imports `@trpc/server`, so a server-side test, a script or a Next.js file that calls a vanilla client beside an adapter import still records it, and so is a `.query` that is not tRPC's: `ctx.db.query(sql)` inside a resolver is `network.rpc` tagged `query:db`, as it always was in a file importing only a client. The convention is restated in each plugin rather than shared: their only common dependency is `@aburi/types`, which holds no library's naming. A base procedure named outside it (`const authed = t.procedure.use(auth)`, then `authed.input(s).query(fn)`) reads as a client call in a file that imports a tRPC client as well; only the binding behind `authed`, which `ClassifyContext` does not carry, would tell them apart. A router key named `procedure` (`client.procedure.list.query`) reads as `t.procedure` does and is declined.

The core records the decline in `stats.declinedCalls[]` (ir-schema.md §2): the plugin, the owner Symbol, the call's `target` and `line`, and `declined` as the entry's `reason`. Without it, a call the plugin chose to leave unclassified and a call no plugin recognized look the same in the IR. `aburi explain` lists a Symbol's entries under `## Declined effects` (markdown-projection.md §7).

`declined` is the plugin's reason, in the plugin's words. Spell it as `derivedBy` is spelled, `effects-plugin:<plugin>:<reason>`, so that a reader can tell which plugin wrote it and two runs over the same code write the same string. It must be a string that is not empty and not only whitespace; any other value fails the run with `scan-plugin-misconfigured`, naming the plugin, when the plugin returns it and whatever a later plugin answers for the call (EP14b). The Document holds it in Unicode NFC, like every string it contains (ir-schema.md §1.2), and quotes it: invariant #19 does not check its spelling.

An answer is a classification or a decline, never both. TypeScript accepts an object carrying `effectId` and `declined` as either member of the union, so the core refuses it at run time: an answer with both keys fails the run with `scan-plugin-misconfigured`, whatever their values (EP14c). Reading it as one of the two would drop the other in silence.

## 5. Classification Algorithm

### 5.1 first-match-wins

```
for each call in symbol.calls:
  declines = []
  for each effect_plugin in config-order:
    result = effect_plugin.classify(call, ctx)
    if result carries both effectId and declined:
      fail the run    # scan-plugin-misconfigured (EP14c)
    if result is an EffectClassification:
      assign call to effects[] with result
      break    # subsequent plugins are not invoked
    if result is an EffectDecline:
      declines += (effect_plugin, result.declined)    # not a match: the next plugin is still asked
  else:
    leave call in calls[]
    record declines in stats.declinedCalls[]
```

Plugins earlier in config order take priority. Placing a project-specific plugin above the standard plugins lets it take precedence.

A decline does not end the dispatch. A plugin lower in the order that does classify the call wins it, and the declines are discarded: the call reached `effects[]`, so no effect is missing (EP14a). Only a call that stays in `calls[]` keeps its declines, one entry for each plugin that declined it.

### 5.1.1 Budget for classify()

The core times each plugin's `classify(call, ctx)` invocation against a **per-call budget**. Default 50ms.

- Override: `config.classifyTimeoutMs` (default `50`, min `10`, max `5000`)
  - For plugins containing an SQL parser, raising it to 200-500ms is realistic
  - No per-plugin override (a single config value shared by all plugins)
- Budget exceeded → the classification is **kept**, exactly as if the call had been fast: a classification moves the call to `effects[]` (EP6); a `null` or a decline passes the call to the next plugin in config order (EP4) and leaves it in `calls[]` when no plugin claims it (EP5, EP14). A kept answer meets the vocabulary check like any other (EP1), so an undeclared id ends a strict run whether or not its call was slow. `classify()` is synchronous, so the clock is read after it returns: the work is already done, and discarding the answer would save nothing while making the IR depend on how busy the machine was. A cold first call (module initialisation, JIT, a GC pause) is the usual overrun
- **Overrun recording**: each overrun (plugin, Symbol, budget) is recorded in `stats.effectClassifyTimeouts[]`, and the CLI's scan prints their count as one warning (`N effect classification(s) ran past the per-call budget; their results were kept.`)
  - An overrun changes this record and nothing else in the Document: `effects[]`, `calls[]` and every fingerprint are what they would have been had the call been fast. The parse budget is different in kind: a file over `parseTimeoutMs` is left out of the Document altogether (lang-plugin.md §7.1.2)
  - CI can compare `effectClassifyTimeouts` across runs to spot plugin performance regressions
- Plugin implementations must be synchronous: a `classify()` that returns a Promise fails the run (`scan-plugin-misconfigured`)
- A decline costs one small record per declining plugin, kept only if the call stays in `calls[]`; its reason is checked when it is returned, whatever a later plugin answers (EP14b). A plugin can decline every call in a large workspace without a log line per call

The budget does not stop a slow plugin — nothing can interrupt a synchronous call — it names one. A plugin that overruns on every call shows up in the stats, call by call, and the remedy is the plugin's.

An overrun is recorded while an input-contract violation (§4.2) fails the run, and the split is deliberate: a slow classifier still received a well-formed callee and returned a well-formed answer, so the run is sound and `stats.effectClassifyTimeouts[]` records which call was slow. A violated input contract has no such bound: the value was never one the pipeline could produce, so nothing downstream of it is trustworthy. Record what you can account for; fail on what you cannot.

### 5.2 Why multiple classification is disallowed

There is a temptation to record `prisma.invoice.create` as both `db.write` (core) and `x-prisma:invoice.create` (Prisma detail), but currently:

- The IR's `Symbol.effects[]` grows complex (differing ids side by side for the same target/line)
- The diff report's ordering conventions break down (which one is canonical?)
- The comprehension load on consumers rises

A single effectId is adopted via first-match-wins. Multiple classification remains an option for a future release via a separate field (`Effect.aliases?: string[]`) — see the [roadmap](../roadmap.md).

### 5.3 Expressing "do not classify" in a higher-priority plugin

Priority control such as "the Prisma plugin should return `x-prisma:create` instead of `db.write`, so place it above the generic plugin that returns core db.*" is done via config order.

Conversely, when a higher-priority plugin wants to defer specific calls to lower ones, it returns `null` and the call flows down. A decline flows down in the same way. The difference is what remains when no plugin below claims the call: after a `null` nothing remains, and after a decline the plugin's reason remains in `stats.declinedCalls[]` (§4.5).

### 5.4 Receiver identification and confidence

A method name is not a library. `delete`, `create`, `update` and `select` are shared vocabulary across `Map`, `Set`, the DOM, RxJS stores and every HTTP router, so a classifier that recognizes a call by its terminal alone will attribute other libraries' calls to its own.

The file-level import gate does not settle this. It answers "does this file use the library", which a file is free to answer yes to while most of its calls belong to something else — an Express router beside its Drizzle queries, a `Map` cache beside a Prisma client. A gate that a mixed file passes wholesale cannot be the last word for the individual calls inside it.

A plugin that matches on shared vocabulary therefore weighs four more things before it commits:

1. **Argument shape.** The library's own signatures rule out collisions for free: no Prisma delegate method and no Drizzle query-builder root takes a bare literal, which is exactly what `router.delete("/users/:id", handler)` opens with. A first argument the library's API could never take is `null`, not a low-confidence effect; `hasLiteralFirstArgument` from `@aburi/plugin-registry/plugin-input` is the shared reader for that literal. A missing argument can be the same signal, but only where a plugin names it per method: Drizzle's `insert`, `update` and `delete` require a table and its `transaction` and `batch` a callback or a statement array, and a zero-argument call to any of them is `null` whatever the receiver. That floor is not the overflow of item 4 turned around. A zero-argument `batch()` / `transaction()` / `update()` / `delete()` has named owners other than the library (Firestore's `batch()`, an unmanaged Sequelize or Knex `transaction()`, an Active Record model's `user.delete()`, a class's own method), where an overflow has none; and a miscount can only reach zero from a comment-only argument list (`db.transaction(/* cb */)`), source that does not run, where a miscount above the maximum is open-ended. It does not claim the source is valid: broken source and another library's call are not separable from the callee string, and recording a phantom `db.write` or `db.transaction` is the costlier mistake, as withdrawing the file over a zero-argument `transaction()` or `batch()` was. There is no shared reader for it; a plugin reads the floor from its own method table, beside the maximum of item 4, and checks `argumentCount` against it.

2. **Model name.** Drizzle's `this.db.delete(table)` has a Prisma delegate's shape, `<client>.<model>.<verb>` with `this` as the client and `db` as the model. A Prisma model is named after a table, so `effects-prisma` answers `null` for a model segment that is exactly a word an ORM binds its client to, its own client words (`prisma`, `db`, `database`, `orm`, `tx`, `trx`) and Drizzle's (`drizzle`, `conn`, `connection`), unless the segment in front of it names a Prisma client (item 3): `this.db.delete` is Drizzle's, and `prisma.tx.create` writes to a `Tx` model. Plugins are asked in config order and the first claim wins (EP4), so the wrong plugin's `medium` claim would otherwise hide the right one's `high`. The model is matched exactly and the client in front word-wise, so `txLog` and `ormMapping` are models, and so is `connection` in `this.prismaService.connection.findMany`: a real write left unclassified is the failure with no trace (item 4). The cost of that is a client word behind a binding that mentions one, `this.dbService.db.delete(table)`, which in a file importing both is still Prisma's.

3. **Receiver name.** The segment holding the client (`prisma` in `this.prisma.user.create`, `db` in `db.select`) is matched word-wise against the plugin's own vocabulary of client binding names — `identifierWords` / `identifierMentions` in the same module, so `prismaClient` and `readReplicaDb` match while `feedback` does not match `db`. Keep the vocabulary to words that actually separate a client from everything else sharing the verbs: `client` matches `apiClient` and `httpClient`, whose `<client>.<resource>.<verb>` shape is a Prisma delegate's exactly, so an entry like that hands the collision the top tier instead of catching it.

4. **Argument count.** Read the arity off the library's own vocabulary table rather than flattening it to a constant — Postgres' `selectDistinctOn(columns, projection)` and `transaction(callback, config)` take two — and treat an overflow as evidence, not proof. `CallCandidate.argumentCount` is a syntactic count, and a classifier reading it as a signature is reading it for more than it promises; a miscount that drops the call erases a real effect and logs nothing, which is the one failure mode with no trace.

The last two set the **tier**, they do not gate the classification:

| signal | outcome |
|---|---|
| receiver names a client binding, arity fits | `confidence: "high"` |
| receiver is a name the plugin cannot place | `confidence: "medium"` |
| `dynamicReceiver` (a collapsed expression) | `confidence: "medium"`, whatever it is spelled |
| more arguments than the method takes | `confidence: "medium"` |

`medium` rather than `null` because the two cases behind an unrecognized name — a client under a house naming convention, and an unrelated object of the same shape — are not separable from the callee string, and effect plugins never see the AST (§6.1): the binding that would separate them reaches a plugin only where `CallCandidate.receiverType` carries it. Dropping the first is as wrong as claiming the second at the tier a hand-annotated effect gets, so the uncertainty is recorded instead of resolved by guessing. This is the same tier `@aburi/framework-express` assigns a route that matches the shape without an import anchor.

A plugin whose vocabulary is its own — a `@Controller` decorator resolved back to the framework's package — has nothing to disambiguate and stays at `high` on shape alone. A `$`-prefixed name the library owns outright is close to that, but not the same thing: the receiver still decides whose `$transaction` it is.

**Receiver type.** Where the language plugin reads the type a receiver is declared with (`CallCandidate.receiverType`, lang-plugin.md §4.4), a match identifies the receiver as a recognised name does: `this.events.emit(…)` beside `constructor(private events: EventEmitter2)` is `EventEmitter2`'s `emit` whatever the field is called, and so is `bus.emit(…)` beside a parameter `bus: EventEmitter2`. A plugin that compares it does so against what the file's imports bind — the class's own name, the local an aliased import gives it, `<namespace>.<class>`, or the local of a default import where the module exports the class as its default — never against a spelling it expects, so a homegrown class of the same name, or one from another module, is not taken for the library's. A match is `high` on its own, and `receiverTypeFromMatchingModule` reads the binding through `ImportEdge.origins`, so a type a workspace barrel re-exports from the library matches as well. The name check still comes first, so a type that binds something else does not veto a recognised name, and a receiver both checks place keeps the name's tag; the field's absence is no evidence either way. The type is the receiver's, the object the method is called on, and for a Prisma delegate call that is the delegate: `this.store.user.findMany()` names `this.store.user`, which no declaration types, so `store: PrismaClient` places `this.store.$transaction(…)` and the raw queries by its type, while the delegate call is graded by the name `store`, `medium` where the file imports Prisma. A delegate call is placed by type only on a receiver declared as the delegate, `this.users.findMany()` beside `users: Prisma.UserDelegate`.

**The workspace's own method.** A call whose receiver is declared with a class the workspace declares, where that class or a workspace class it extends declares the member called, never reaches an effect plugin: it is the class's method, which call resolution takes, and what the method does reaches the caller by propagation. `this.usersService.create(dto)` beside `constructor(private usersService: UsersService)` resolves to `UsersService.create` though the controller imports a Prisma type, and `this.repo.update(id, dto)` to the repository's `update` though it imports `drizzle-orm`. The core reads the class from the file's candidates or, through the import that binds the type, from the module that declares it, re-exports and `export *` followed. A member the class inherits from a package is the library's, so `this.prisma.$transaction(…)` on a `PrismaService` that extends `PrismaClient` is still classified, and so is a call on a receiver declared with a type alias (`type Db = typeof db`), which declares no member of its own.

## 6. Cooperation with Language Plugins

### 6.1 Information reaching the effect plugin

Once the language plugin's `walkBody` returns a `CallCandidate`, the core routes it to each effect plugin. Effect plugins never access the AST.

### 6.2 Invocation relative to owner Symbol determination

Some effect plugins make decisions that depend on the owner's `extKind` (already determined by the framework plugin) — e.g. NestJS lifecycle is only meaningful inside `framework:nestjs:provider`.

Therefore the extraction order is (see [`lang-plugin.md`](./lang-plugin.md) §5.3):

```
extractSymbols → framework.classifySymbol → walkBody → effects.classify
```

By the time an effect plugin is invoked, owner.extKind has been determined.

### 6.3 The same call never has multiple owners

A call_expression belongs to a single owning Symbol (nested anonymous functions are absorbed into the parent, [`ir-schema.md`](./ir-schema.md) §3.3). Effect plugins never face ambiguity in identifying the owner.

## 7. Drop Additions by Logger-Oriented Plugins

Providing `dropCallees: string[]` on the plugin object (§4.1; the manifest has no such field) adds the given callee prefixes to the core's drop-list category C ([`drop-list.md`](./drop-list.md) §5.2).

Example: if the `effects-pino` plugin declares `["pino", "child"]`, then `pino.info(...)` / `child.info(...)` are excluded from effects/calls.

Writing a drop-only plugin is also possible (`provides.effects: []` but declaring `dropCallees` only).

## 8. Official Effect Plugins (planned)

| plugin | example recognized callees | main effect ids |
|---|---|---|
| `@aburi/effects-nest` | `EventEmitter2` / `eventBus` `.emit(...)` and `.emitAsync(...)`, the same on a field declared as `EventEmitter2`, and `@nestjs/cqrs`'s `EventBus` `.publish(...)` / `.publishAll(...)` | `event.publish` |
| `@aburi/effects-prisma` | `prisma.*.{find*,create,update,upsert,delete}` | `db.read` / `db.write` |
| `@aburi/effects-drizzle` | `db.select().from(...)` / `db.insert(...)` | `db.read` / `db.write` |
| `@aburi/effects-trpc` | `trpc.*.{query,mutation}` and the React Query hooks | `network.rpc` |
| `@aburi/effects-axios` | `axios.{get,post,put,patch,delete}` | `network.http` |
| `@aburi/effects-fetch` | `fetch(...)` (global) | `network.http` |
| `@aburi/effects-bullmq` | `queue.add(...)` / worker | `queue.publish` / `queue.consume` |
| `@aburi/effects-redis` | `client.{get,set,del}` | `x-redis:read` / `x-redis:write` (core `state.*` is in-process only, so Redis is expressed via plugin extension) |
| `@aburi/effects-pino` | `pino.*` / `child.*` | dropCallees only (logger exclusion) |
| `@aburi/effects-winston` | `winston.*` | same as above |
| `@aburi/effects-otel` | `tracer.*` / `metrics.*` / `span.*` | same as above |

Implementation details of each plugin live in their respective READMEs. Today `effects-nest`, `effects-prisma`, `effects-drizzle` and `effects-trpc` are implemented; the rest are planned — see the [roadmap](../roadmap.md).

## 9. Pattern-Matching Implementation Examples

### 9.1 Prisma effect plugin (pseudocode)

```ts
import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  identifierMentions,
  importGate,
  receiverTypeFromMatchingModule,
  typedReceiverConfidence,
} from '@aburi/plugin-registry/plugin-input'
// `prismaClientModuleMatcher` over `pluginOptions["effects-prisma"].clientModules`, built once a config.
import { clientModuleMatcherFor } from './options'

const READ_METHODS = /^(findUnique|findFirst|findMany|count|aggregate|groupBy)$/
const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const TX_METHOD = '$transaction'
const RAW_QUERY_METHODS =
  /^\$(queryRaw|queryRawUnsafe|queryRawTyped|executeRaw|executeRawUnsafe|runCommandRaw)$/

// Words a Prisma client binding is spelled with. `client` is deliberately absent: it
// matches `apiClient` / `httpClient`, whose `<client>.<resource>.<verb>` shape is a
// delegate call's shape exactly (§5.4).
const PRISMA_CLIENT_WORDS = new Set(['prisma', 'db', 'database', 'orm', 'tx', 'trx'])
// No model is named after a client, Drizzle's included (§5.4 item 2).
const CLIENT_BINDING_WORDS = new Set([...PRISMA_CLIENT_WORDS, 'drizzle', 'conn', 'connection'])

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-prisma.json */ },

  async init(ctx) {},

  classify(call, ctx) {
    const origin = { plugin: 'effects-prisma', filePath: ctx.file.path }

    // decompose the identifier chain: "prisma.invoice.create" → ["prisma", "invoice", "create"]
    // The shared guard rejects an unnormalized callee instead of splitting it silently, and
    // runs before the import gate so an upstream bug is not narrowed to Prisma files.
    const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

    // `@prisma/client` and its subpaths, a driver adapter or client extension, a client
    // generated to `generated/prisma`, and the modules `clientModules` names.
    const isPrismaClientModule = clientModuleMatcherFor(ctx.config)

    // Does this file use Prisma at all, itself or through a module it imports from (§4.3)?
    // Necessary, never sufficient (§5.4).
    const gate = importGate(ctx.file.imports, parts[0], origin, isPrismaClientModule)
    if (gate === null) return null
    // A receiver declared with Prisma's own type is its client whatever it is called (§5.4).
    const typed = receiverTypeFromMatchingModule(
      ctx.file.imports, call.receiverType, origin, isPrismaClientModule,
    )
    // Short of an import of Prisma that is the file's own or binds the leading name, the client
    // must be one its type or its name places.
    const placed = (client) =>
      gate === 'direct' || typed || identifierMentions(client ?? '', PRISMA_CLIENT_WORDS)

    // `<client>.$transaction(...)` is 2 segments, and its callback form takes a second
    // options argument — so it is dispatched before the 3-segment delegate shape and
    // carries its own arity.
    if (method === TX_METHOD) {
      if (parts.length < 2) return null
      if (hasLiteralFirstArgument(call)) return null
      if (!placed(parts[parts.length - 2])) return null
      return {
        effectId: 'db.transaction',
        confidence: typed ? typedReceiverConfidence(call, 2) : tier(parts[parts.length - 2], call, 2),
        derivedBy: 'effects-plugin:prisma:tx',
      }
    }

    // Whether a raw query reads or writes is in the query, which the call site does not
    // spell: the call is Prisma's, and the plugin declines to name its effect (§4.5).
    // Ahead of the literal check, since `$executeRawUnsafe("…")` takes its SQL as one.
    if (RAW_QUERY_METHODS.test(method) && parts.length >= 2) {
      if (!placed(parts[parts.length - 2])) return null
      return { declined: 'effects-plugin:prisma:raw-query' }
    }

    // A delegate call is `<client>.<model>.<verb>`; the client segment is what stops a
    // two-segment `router.create(...)` from matching.
    if (parts.length < 3) return null

    // No delegate takes a bare literal, so `map.delete("id")` is another API.
    if (hasLiteralFirstArgument(call)) return null

    // A model is named after a table: `this.db.delete(table)` is another ORM's client,
    // unless a Prisma client stands in front of it, as in `prisma.tx.create` (§5.4).
    const model = parts[parts.length - 2]
    const client = parts[parts.length - 3]
    if (CLIENT_BINDING_WORDS.has(model) && !identifierMentions(client, PRISMA_CLIENT_WORDS)) {
      return null
    }
    if (!placed(client)) return null

    // The receiver here is the model's delegate, so only one declared as such carries a type.
    const confidence = typed ? typedReceiverConfidence(call, 1) : tier(client, call, 1)

    if (READ_METHODS.test(method)) {
      return { effectId: 'db.read', confidence, derivedBy: 'effects-plugin:prisma:read' }
    }
    if (WRITE_METHODS.test(method)) {
      return { effectId: 'db.write', confidence, derivedBy: 'effects-plugin:prisma:write' }
    }
    return null
  }
}

// The receiver and the argument count set the tier; neither gates the classification (§5.4).
function tier(receiver, call, maxArguments) {
  if (call.dynamicReceiver) return 'medium'
  if (call.argumentCount > maxArguments) return 'medium'
  // Word-wise against the client vocabulary, so `prismaClient` / `readReplicaDb` match and
  // `cache` / `router` do not — see `namesPrismaClient` in @aburi/effects-prisma.
  return identifierMentions(receiver ?? '', PRISMA_CLIENT_WORDS) ? 'high' : 'medium'
}
```

### 9.2 NestJS lifecycle effect plugin (pseudocode)

```ts
const LIFECYCLE_METHODS = {
  onModuleInit: 'x-nest:lifecycle.on-module-init',
  onApplicationBootstrap: 'x-nest:lifecycle.on-application-bootstrap',
  onModuleDestroy: 'x-nest:lifecycle.on-module-destroy',
  onApplicationShutdown: 'x-nest:lifecycle.on-application-shutdown',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-nest.json */ },
  classify(call, ctx) {
    // If we design effect propagation for "calls to other symbols inside a lifecycle hook body", that is a separate consideration
    // currently "the invocation of the lifecycle hook itself" is not treated as an effect (the framework plugin handles that via extKind)
    return null
  },
  dropCallees: []  // NestJS passes loggers via DI rather than a separate module, so nothing is dropped here
}
```

(NestJS lifecycle does not appear as calls; it is determined by method name and framework boundary, so it is the framework plugin's responsibility, not the effect plugin's.)

### 9.3 Stripe effect plugin (pseudocode)

```ts
import { assertNonEmptySegments, hasMatchingImport } from '@aburi/plugin-registry/plugin-input'

const ACTIONS = {
  charges: 'x-stripe:charge',
  customers: 'x-stripe:customer.create',  // when method is create
  webhooks: 'x-stripe:webhook.deliver',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-stripe.json */ },
  classify(call, ctx) {
    const origin = { plugin: 'effects-stripe', filePath: ctx.file.path }
    const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)
    if (parts.length < 3) return null
    const resource = parts[parts.length - 2]

    if (!hasMatchingImport(ctx.file.imports, origin, source => source === 'stripe')) return null

    if (resource === 'charges' && method === 'create') {
      return { effectId: 'x-stripe:charge', confidence: 'high', derivedBy: 'effects-plugin:stripe:charge' }
    }
    // ... and so on
    return null
  }
}
```

## 10. Verifiable Properties (Test Criteria)

| ID | Input | Expected |
|---|---|---|
| EP1 | returning an effectId not in the manifest | extraction-time error (detected by the registry) |
| EP2 | classify returns the same output for the same input | purity (no side effects, no held state) |
| EP3 | classify throws from its own classification logic | **not implemented.** Nothing between the classifier and the core's per-file boundary catches a throw, so this behaves as EP3a and withdraws the file. The two are told apart by code: an EP3a violation's `extractionFailures` entry carries a `PluginInputError` code (§4.2), and a classifier's own throw carries none of them |
| EP3a | classify throws an input-contract violation (§4.2) | propagates out of classification rather than degrading to an unclassified call; the core's per-file boundary (lang-plugin.md §7.2) then withdraws the file, names it in `skipped` and in `extractionFailures` with the guard's code (`unnormalized-callee` for an empty target segment), and `aburi scan` exits non-zero |
| EP4 | 2 plugins classify the same call | the first in config order wins (first-match-wins) |
| EP5 | classify returns null | the call stays in `Symbol.calls[]` |
| EP6 | classify returns an EffectClassification | the call moves to `Symbol.effects[]` and does not stay in `Symbol.calls[]` |
| EP7 | plugin declaring `dropCallees` | matching callees are excluded from effects/calls, same as drop-list §5.2 |
| EP8 | logger-only plugin with `effects: []` and `dropCallees: ["pino"]` | classify keeps returning null, but pino.* is dropped |
| EP9 | returning any id under `effectPrefixes: ["x-stripe"]` | OK (no individual declaration needed) |
| EP10 | classify returns `confidence: 'low'` | Symbol.effects[].confidence = "low" goes into the IR as-is |
| EP11 | a call matching a plugin's shared-vocabulary shape on a receiver the plugin cannot identify (§5.4) | the effect is still recorded, at `confidence: "medium"` — not `high`, and not dropped |
| EP12 | a call whose shape no signature in the plugin's vocabulary takes: a literal first argument, or no argument to a method that requires one (§5.4 item 1) | `null` (EP5), whatever the receiver: the call stays in `Symbol.calls[]` and the file keeps its Symbols. Not EP3a — the candidate is well formed, so this is a classification decision, not an input-contract violation |
| EP11a | `prisma.user.findMany()` after `import { prisma } from "./lib/db"`, where `lib/db` imports `@prisma/client`; `this.prisma.post.delete(…)` beside `constructor(private prisma: PrismaService)`, where `PrismaService` extends `PrismaClient` (§4.3) | `db.read` and `db.write`, each `high`, with no Prisma import in the file. `this.store.entries.delete({ key })` in the second file stays in `calls[]`: only a module it imports from uses Prisma, and no client name places `store` |
| EP11b | `this.usersService.create(dto)` beside `constructor(private usersService: UsersService)`, `UsersService` a workspace class that declares `create` and the module exports by its name, as its default or under the name an export clause gives it, in a file that also imports a Prisma type (§5.4) | no plugin is asked about the call: it stays in `calls[]`, resolved to `UsersService.create`, and the write the method makes reaches the caller as a propagated effect |
| EP11c | `usersRepo.update(id, dto)` after `import { usersRepo } from "./users.repo"`, where that module imports `drizzle-orm` and exports `new UsersRepo()`; `cache.entries.delete({ key })` after `import { cache } from "./lib"`, where `lib` is `export * from "./db"` and `export * from "./cache"` and only `db` imports `@prisma/client` (§4.3) | both stay in `calls[]`: the first name is `bound` and no client name places it, and the second leads to no module that imports Prisma, since `./cache` is the target that exports it |
| EP11d | a client imported from `./db` as `prisma` and as `store`, and `cache` imported from a `./cache` that imports nothing from Prisma, each with and without `import type { User } from "@prisma/client"` beside it (§4.3) | the type import changes nothing: `prisma.user.create(…)` is `db.write`, `high`, both ways, and `store.user.create(…)` and `cache.user.create(…)` stay in `calls[]` both ways |
| EP12a | `this.db.delete(auditLog)` in a file that imports both `@prisma/client` and `drizzle-orm`, with `effects-prisma` listed first (§5.4 item 2) | `effects-prisma` answers `null`, so `effects-drizzle` records `db.write` at `high`, as it does for `this.conn.delete(auditLog)`. `prisma.txLog.create(…)`, and `prisma.tx.create(…)` on a `Tx` model, are still Prisma's |
| EP13 | classify returns after running past `classifyTimeoutMs` (§5.1.1) | its answer is used as if it had been fast — EP6 for a classification, EP5 for `null`, EP14 for a decline, and EP4 still decides the order — and the overrun is one `stats.effectClassifyTimeouts` entry. `effects[]`, `calls[]` and the fingerprints do not depend on whether this classification overran its budget |
| EP14 | classify returns `{ declined: reason }` (§4.5) and no later plugin classifies the call | the call stays in `Symbol.calls[]` (EP5), and `stats.declinedCalls[]` gains one entry: `plugin`, `symbolId`, `target`, `line`, and the reason. Neither `effects[]`, `calls[]` nor any fingerprint differs from a `null` |
| EP14a | a plugin declines a call and a later plugin classifies it | the later plugin's classification is used (EP6), and no `stats.declinedCalls[]` entry is written for that call |
| EP14b | `declined` is empty, only whitespace, or not a string | the run fails with `scan-plugin-misconfigured`, naming the plugin, whether or not a later plugin classifies the call |
| EP14c | classify returns an object carrying both `effectId` and `declined` | the run fails with `scan-plugin-misconfigured`, naming the plugin, whatever the two values are |

## 11. Design Decisions

### 11.1 Why effect plugins center on pure functions

The `classify(call, ctx) → result` shape:

- Makes unit testing easy (no stateful test harness needed)
- Is parallelizable (future performance improvements)
- Never touches the AST directly, so it is unaffected by internal implementation changes in language plugins

To preserve the responsibility split of the whole extraction pipeline, effects stick strictly to "classification".

A decline (§4.5) is a return value, not a log line. A plugin could also report why it skipped a call through a `Logger` added to `ClassifyContext`, but three things count against it. Logging is a side effect that EP2 would have to allow. The line goes to a terminal, not to the IR that a reviewer, `aburi diff` and a CI job read. And the logger would be called inside the scan's innermost loop, once per call, within a 50ms budget. A returned reason keeps `classify()` pure, is stored in the IR next to the call it is about, and costs one small record, kept only when the call stays in `calls[]`.

### 11.2 Choosing first-match-wins

Config order is a deterministic priority control: behavior is controlled with a single setting. Neither "complex consensus schemes" nor "weighted voting" needs to be introduced today.

If a user wants Prisma's `db.write` emitted as `x-prisma:create`, they place the Prisma plugin first.

### 11.3 Why effect plugins cannot write Symbol.derivedBy directly

`Symbol.derivedBy[]` is the evidence set for "why this Symbol appears in the IR in this form". An effect determination is evidence for a specific call, not for the Symbol as a whole, so the per-effect `Effect.derivedBy` (a single value) suffices.

For the use case of searching "Symbols that use Prisma" at the Symbol level, looking at `Symbol.effects[]` is enough.

### 11.4 Cross-language reuse

Prisma is used from TS and from Python alike (`prisma-client-py`). Because effect plugins are language-independent by design, a single plugin can recognize Prisma calls in both languages.

`ClassifyContext.language` is provided, so per-language behavior switches are also possible.

### 11.5 Why using owner.extKind is allowed

It enables context-dependent determinations such as "treat `this.bus.send(...)` as `event.publish` only inside `framework:nestjs:provider`". owner.extKind has already been determined by the framework plugin (extraction order per lang-plugin §5.3).

### 11.6 Why literal analysis of SQL strings is included from the start

String-based ORMs like `db.query("SELECT * FROM users WHERE id = ?")` are common in real projects. Including `literalArgs` in CallCandidate makes analysis of string contents possible in a plugin, combined with an SQL parser library. The constraint of never accessing the AST stays intact; only the necessary information is added.
