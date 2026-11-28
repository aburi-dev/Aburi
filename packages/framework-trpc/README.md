# @aburi/framework-trpc

tRPC framework plugin for `@aburi/core`. Classifies the **server** side of
tRPC — the instance, routers, procedures, base procedures and middleware —
into `framework:trpc:*` extKinds, so they are Boundaries in the IR. The client
side, the calls that reach a procedure over the network, is
[`@aburi/effects-trpc`](../effects-trpc/README.md)'s.

Every shape is a `const` whose own declarator holds it:

| Source shape | `extKind` | `derivedBy` |
|---|---|---|
| `const t = initTRPC.create()`, `initTRPC.context<Context>().meta<Meta>().create({ … })` | `framework:trpc:instance` | `framework:trpc:instance:initTRPC.create` |
| `const appRouter = t.router({ … })`, `router({ … })`, `createTRPCRouter({ … })` | `framework:trpc:router` | `framework:trpc:router:t.router` |
| `const merged = t.mergeRouters(a, b)`, `mergeRouters(a, b)` | `framework:trpc:router` | `framework:trpc:router:t.mergeRouters` |
| `const byId = publicProcedure.input(schema).query(({ input }) => …)` | `framework:trpc:procedure` | `framework:trpc:procedure:publicProcedure.query` |
| `const create = protectedProcedure.mutation(…)`, `t.procedure.subscription(…)` | `framework:trpc:procedure` | `framework:trpc:procedure:protectedProcedure.mutation` |
| `const publicProcedure = t.procedure` | `framework:trpc:base-procedure` | `framework:trpc:base-procedure:t.procedure` |
| `const protectedProcedure = t.procedure.use(isAuthed)`, `protectedProcedure.use(isAdmin)` | `framework:trpc:base-procedure` | `framework:trpc:base-procedure:t.use` |
| `const isAuthed = t.middleware(({ ctx, next }) => …)`, `middleware(fn)` | `framework:trpc:middleware` | `framework:trpc:middleware:t.middleware` |

A procedure is a `query`, `mutation` or `subscription` handed its resolver — a
function, an async generator (tRPC v11's subscriptions), a name for one, or a
call that returns one (`withCache(listUsers)`) — on a chain built from a
procedure: one that reads `.procedure` straight off a plain name
(`t.procedure.query(…)`) or starts from a name that is `procedure` or ends in
`Procedure` (`publicProcedure`, `protectedProcedure`), which is how tRPC's
documentation and create-t3-app name their base procedures. The chain is what
tells `publicProcedure.query(resolve)` from `db.query(fn)` and from the client
call `client.user.byId.query({ id })`. A base procedure is the same chain ending
in `use`, `input`, `output`, `meta` or `concat` instead, or the bare
`t.procedure`. That bare read is taken only off a plain name and only in a file
that imports `@trpc/server`, the file that creates the instance: `procedure` is
a domain word as well, and `form.procedure` reads the same. The three procedure
kinds share one extKind, as an Express route's methods do, and `derivedBy` names
which one it is.

A router is `router` or `createTRPCRouter` handed one object literal, or
`mergeRouters` handed the routers it merges; another library's
`createRouter({ routes })` is not one. An alias of a factory
(`export const createTRPCRouter = t.router`) is not classified: it builds
nothing until it is called.

`derivedBy` names the call `<receiver>.<method>`, read off the syntax tree as
every framework plugin reads it: the method called and the name the receiver
chain starts from, through `as`, `satisfies`, `!`, parentheses and every call
on the way. So a chain wrapped over several lines, or with a comment in it,
gives the same entry, and `t.procedure.use(timing).query(fn)` is
`t.query`. The bare `t.procedure` is named the same way, `t.procedure`.

Confidence is `high` when the file imports `@trpc/server` or one of its
subpaths, type-only imports included, and `medium` otherwise. Most of the
names this plugin reads are tRPC's conventions rather than its exports
(`initTRPC` is the exception), and the usual layout keeps the import in one
file: create-t3-app's routers import
`createTRPCRouter` and `publicProcedure` from `~/server/api/trpc`, so their
routers and procedures are `medium`.

A procedure's resolver is its Symbol's body, so the calls, rules and effects
written in it are the procedure's: with
[`@aburi/effects-prisma`](../effects-prisma/README.md), a mutation whose
resolver calls `prisma.user.create(…)` carries `db.write`.

A procedure or base procedure also names its middleware, which `@aburi/core`
writes to the Symbol's `middleware` and the logic fingerprint reads, so a
procedure that loses `.use(isAuthed)` is a logic change the report names
(`- middleware removed: isAuthed`) rather than a reformat, and two `.use` calls
swapped are one with `reordered: true`. The names are, in the order they run,
the base procedure the chain starts from, what each `.use(…)` on the
declaration's own chain is handed, and the builder each `.concat(…)` joins:
`t.procedure.use(timing).use(isAuthed).query(fn)` names `timing` and
`isAuthed`, and `protectedProcedure.use(isAdmin).mutation(fn)` names
`protectedProcedure` and `isAdmin`. A base procedure runs its middleware ahead
of what is built on it, as the builder a `.concat(…)` joins runs its own where
the call is written, so a mutation moved from `protectedProcedure` to
`publicProcedure` is a logic change too. The instance's `t.procedure` adds
nothing and is not named. An inline middleware is left out, since its body is
the Symbol's own and already read. Each entry is named from the syntax tree as
[`@aburi/framework-express`](../framework-express/README.md) names its
middleware, so line breaks, comments and quote style do not reach it:
`isAuthed`, `auth.required`, `requireRole("admin")` for `requireRole('admin')`,
`rateLimit(…)` for `rateLimit({ max: 10 })`, and `<computed>` for anything no
name spells.

What a base procedure adds is named on the base procedure itself: removing
`.use(isAuthed)` from `protectedProcedure = t.procedure.use(isAuthed)` changes
the `middleware` of `protectedProcedure` alone. The plugin reads one
declaration at a time, so the `middleware` of what is built on it names
`protectedProcedure` as before, not `isAuthed`. What the call to
`protectedProcedure` carries to them is in the next paragraph.

The base procedure and the middleware handed over by name are also the
Symbol's calls, which `@aburi/core` resolves as it resolves the calls written
in the body: `protectedProcedure.use(isAdmin).mutation(fn)` calls
`protectedProcedure` and `isAdmin`, at the lines they are written on. A
procedure has an edge to what it is built on, so an effect a base procedure or
a middleware performs propagates to it (a `db.read` in `isAdmin` is the
mutation's too), and `aburi explain` on the base procedure lists the
procedures built on it under Called by. A member path is read as a call target
is: `auth.required`, and `handlers.auth` for `handlers["auth"]`. A factory call
(`requireRole("admin")`, or `createProcedure("read")` at the start of the chain)
is a call of the body already, and an inline
middleware is the body itself, so neither is added, nor is a spread or a
computed member, which names no Symbol. The edge carries effects, not rules: a
guard removed from `protectedProcedure` changes `protectedProcedure` alone, and
the report lists a procedure built on it only when the change moves an effect
the procedure inherits.

A procedure written inside a router's object literal has no Symbol of its own,
so the router names, for each, what it is built on, prefixed by the path a
client calls it by: `t.router({ list: publicProcedure.query(fn), delete:
protectedProcedure.use(isAdmin).mutation(fn) })` names
`delete:protectedProcedure`, `delete:isAdmin` and `list:publicProcedure`, and
calls `protectedProcedure`, `isAdmin` and `publicProcedure`. Switching `delete`
to `publicProcedure` is then a logic change to the router
(`- middleware removed: delete:protectedProcedure`). The entries follow the
paths rather than the order the keys are written in, since tRPC serves a
procedure by its path, so swapping two keys is no logic change.

A router written inside one is read the same way under the path of keys
(`post.delete:protectedProcedure`), whether it is a `t.router({ … })`, a plain
object (`post: { delete: … }`) or a `t.mergeRouters(…)` of routers built in
place. A key is the name of the property it makes: `"by-id"`, `["by-id"]` and
`` [`by-id`] `` give `by-id:`, `0x10` gives `16:`, and a key read only at run
time gives `<computed>:`. A quoted `"post.delete"` key and a `delete` inside
`post` give one path, the one a client calls either by.

A procedure on the instance's own `t.procedure` names no base procedure, as it
does when declared as a `const`: `list: t.procedure.use(isAdmin).query(fn)`
names `list:isAdmin`. A procedure or router the object names by reference
(`{ list }`, `{ post: postRouter }`) names nothing, since it carries its own.

Not linked today:

- A middleware composed inside the `.use(…)` or `.concat(…)` that hands it
  over (`t.procedure.use(isAuthed.unstable_pipe(isAdmin))`,
  `.concat(other.use(x))`). The only call recorded is the body's
  `isAuthed.unstable_pipe`, a method no Symbol declares, so neither `isAuthed`
  nor `isAdmin` has an edge and their effects do not reach the procedure.
  Declare the composed middleware as a `const` and hand that name over.

Not named today:

- The body of a middleware made in the `.use(…)` that hands it over
  (`t.procedure.use(t.middleware(async ({ ctx, next }) => { … }))`). The entry
  is named `t.middleware(…)`, but `@aburi/lang-typescript` reads only the
  functions handed straight to a call on the chain, so an edit inside that
  body is syntax-only and two such middleware read alike. Declare it as a
  `const` (`const isAuthed = t.middleware(…)`), a middleware Symbol whose body
  is read, and hand that name to `.use(isAuthed)`.
- Where a `.use(…)` sits against `.input(…)` and `.meta(…)`. A middleware
  ahead of `.input(…)` runs without the parsed input, and one that reads `meta`
  sees what `.meta(…)` set, but the list holds middleware alone, so moving a
  `.use` across either leaves it as it was.

Not classified today:

- A procedure written inside a router's object literal
  (`router({ byId: publicProcedure.query(…) })`). `@aburi/lang-typescript`
  gives an object handed to a call no member Symbols, so there is no Symbol to
  classify. The router is classified, and it walks its whole call, so the
  procedure's resolver is the router's: its calls, rules and effects are on the
  router, and an edit to its rules or effects is a logic change to the router,
  as is a change to what it is built on, which the router names. Declare the
  procedure as a `const` and name it in the router to give it a Symbol of its
  own.
- What is built on a base procedure whose name is neither `procedure` nor ends
  in `Procedure` (`const base = t.procedure`, then `base.query(fn)` or
  `base.use(x)`). `base` itself is classified, but the plugin reads one
  declaration at a time, so it cannot see where `base` came from.
- The bare `t.procedure` in a file that does not import `@trpc/server`.
- A router or middleware factory under a name other than tRPC's
  (`const makeRouter = t.router`, then `makeRouter({ … })`), for the same reason.
- `experimental_standaloneMiddleware`, `createCallerFactory(appRouter)` and
  `appRouter.createCaller(ctx)`.

Classified though not tRPC's: the receiver's name is all a declaration shows,
so another library's shapes under tRPC's names are read as tRPC's, at `medium`
in a file that does not import `@trpc/server`. A ts-rest contract
(`c.router({ getPost: … })`) and an oRPC router (`os.router({ ping })`) are
routers, `app.middleware(handler)` is a middleware, and a `query` on a name
ending in `Procedure` (`storedProcedure.query(sql)`) is a procedure.

## Install

```bash
pnpm add -D @aburi/framework-trpc
```

## Usage

```ts
import { trpcFrameworkPlugin } from "@aburi/framework-trpc"
```

The plugin's `provides.frameworks: ["trpc"]` matches `@aburi/core`'s Component
autodetect against a workspace `@trpc/server` npm dependency, and `aburi init`
writes `"framework-trpc"` into `aburi.json`'s `frameworks` array for one.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:trpc:*`) plug into the shared vocab.
- [`@aburi/effects-trpc`](../effects-trpc/README.md) — the client side of tRPC.
