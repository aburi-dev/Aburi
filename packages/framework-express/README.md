# @aburi/framework-express

Express framework plugin for `@aburi/core`. Classifies Router instances, HTTP
route handlers, middleware, error-handling middleware, and sub-router mount
points into `framework:express:*` extKinds so downstream tooling can group them
in the workspace projection.

Recognised shapes:

| Source shape | `extKind` | Signal |
|---|---|---|
| `const r = Router()` / `const r = express.Router()` | `framework:express:router` | Router factory call bound to that const's own declarator; in `const a = 1, r = Router()` only `r` |
| `app.get('/users', h)` / `router.post(…)` | `framework:express:route` | member call whose leaf is `get`/`post`/`put`/`patch`/`delete`/`all` and handed a handler after its path |
| `app.use((req, res, next) => …)` | `framework:express:middleware` | `.use(…)` with an arity-3 inline handler |
| `app.use(logger)` | `framework:express:middleware` | `.use(…)` with an out-of-scope identifier argument (confidence: `medium`) |
| `app.use((err, req, res, next) => …)` | `framework:express:error-middleware` | `.use(…)` with an arity-4 handler |
| `app.use('/api', router)` | `framework:express:mount` | `.use(pathLiteral, identifier)` two-arg shape |

Priorities inside `.use(...)` are first-match-wins in the order above: an
arity-4 handler always wins over any other shape, then the two-arg
`(path, identifier)` mount pattern, then plain middleware.

A route method's name is shared vocabulary (`map.delete(key)`,
`settings.get("port")`, Express's own settings getter `app.get("env")`), so a
call is a route only when its arguments have a registration's shape. The first
argument is taken as the path, and its shape is not checked, so
`app.get(ROUTES.users, h)` is a route. At least one argument after it must be
handler-shaped: an inline function, an identifier, a member path (`users.list`,
`handlers["list"]`), a call (`asyncHandler(h)`,
`passport.authenticate("local")`), a choice between those
(`isProd ? cached : live`, `custom || fallback`, `options.handler ?? fallback`),
or an array or spread of them. Data in the handler's place does not count, so
`axios.post(url, { id })` is not a route, but an identifier can name data as
well as a function, so `cache.put(key, value)` is one. Two shapes have no path
to skip, and a handler alone makes them a route: a chain that has called
`.route(path)` with a literal path beginning with `/`, on any receiver and at
any depth (`app.route("/users").get(listUsers).post(createUser)`), and a call
whose first argument is a spread (`app.get(...routeArgs)`).

Arguments and a route's receiver chain are read through `as`, `satisfies`, `!`
and parentheses, as `@aburi/lang-typescript` reads them to name the
registration, and so is a Router's initializer:
`app.use(logger as RequestHandler)` is middleware as `app.use(logger)` is,
`app.route("/users")!.get(h)` is a route as `app.route("/users").get(h)` is,
and `const r = express.Router() as express.Router` is a Router.

`derivedBy` names the call `<receiver>.<method>`, read off the syntax tree as
`@aburi/lang-typescript`'s `call-statement:` entry is: the method called and
the name the receiver chain starts from, through those wrappers and every call
on the way. `app.get("/users", h)`, `(app as Express).get("/users", h)`, the
same call wrapped over two lines or with a comment before `.get`, and
`app.route("/users").get(h)` all give `framework:express:route:app.get`, and
`app.use(cors()).use("/api", apiRouter)` gives
`framework:express:mount:app.use`. A Router is named by its factory the same
way: `Router`, `express.Router`, and `require.Router` for
`require("express").Router()`. No entry carries the source's line breaks,
indentation or comments, so reformatting a call leaves its entries as they
were. A route chain that registers several methods is one Symbol, named after
its last, and `derivedBy` names that method first and then each other method in
the order the chain registers them:
`app.route("/users").get(listUsers).post(createUser)` gives
`framework:express:route:app.post` and `framework:express:route:app.get`, so a
filter on either method finds the chain.

A route or `use` registration also names its middleware, which `@aburi/core`
writes to the Symbol's `middleware` and the logic fingerprint reads, so a route
that loses its authorization check is a logic change the report names (`-
middleware removed: requireAdmin`) rather than a reformat. For a route it is
every handler argument but the last, the handler; for `use`, every argument
after the path, the router a mount hands over included; in a chain, each
registration's in the order the chain makes them. An `all` with a later method
in its chain (`app.route("/users").all(requireUser).get(listUsers)`) runs ahead
of each of them, so every argument it takes is middleware. A `use` path is
whatever Express reads as one, so `["/a", "/b"]`, `/^\/admin/` and ``
`/v${version}` `` are skipped as `"/admin"` is. A path held in a name
(`app.use(API_PREFIX, apiRouter)`) cannot be told from middleware by the
syntax, so it is named, and called, as middleware.

One Symbol holds every route a statement registers. Where it holds several, as
a `.route(path)` chain or `app.get("/a", requireUser, listA).post("/b",
createB)` does, each entry names the method it guards, so the list says which
method each guard is on:
`app.route("/users/:id").get(getUser).put(requireAdmin,
updateUser).delete(deleteUser)` names `get:`, `put:requireAdmin` and `delete:`.
A route that takes no middleware is the bare mark (`get:`), which runs nothing,
so moving a guard to another method, adding a method or dropping one is a logic
change (`- middleware removed: delete:requireAdmin`), not a reformat. A
`.route(path)` chain is qualified and marked even while it holds one method
(`app.route("/users").get(listUsers)` names `get:`), so adding a method or
dropping one changes the list by that method's entries alone. A plain
`app.get("/users", requireAdmin, listUsers)` names `requireAdmin`, its method
being in the Symbol's name already, and what a `use` takes is never prefixed.

Arrays and spreads of arrays are flattened, as Express flattens them. An inline
function is left out, since its body is the registration's own and already
read. Each entry is named from the syntax tree, so line breaks, comments and
quote style do not reach it: `requireAdmin`, `auth.required`, `handlers.auth`
for `handlers["auth"]`, a factory with its literal and named arguments, a
string written back in double quotes (`requireRole("admin")` for
`requireRole('admin')`, and `rateLimit(…)` for `rateLimit({ max: 10 })`),
`...guards` for a spread whose contents the statement does not show, and
`<computed>` for anything else. A `use` with no path is named by its arguments
already, so changing them makes it another registration rather than a changed
one; app-level `app.use(mw)` above a route is its own registration and is not
counted toward that route.

Confidence is `high` when the file imports the `express` package or one of its
subpaths (or reaches Express via CommonJS `require('express')`) and `medium`
otherwise — the classification survives so the workspace projection still
surfaces the shape, but consumers can treat medium-confidence rows as
candidates for review. The import is read from the file's parsed import list,
so the line breaks it is written with do not matter and a commented-out import
does not count. The list holds a CommonJS `require("express")` too. When it
names no `express`, the source is read as tokens, with comments skipped and
literals read whole, for an import or a `require` call the list missed (one the
parser lost to a syntax error, or an import inside a `declare module` block).
JSX text with a quote or backtick in it can mislead that reading on the lines it
spans.

Every handler a registration names is also a call it makes, since Express runs
it: `app.get("/users", requireAdmin, listUsers)` calls `requireAdmin` and
`listUsers`, so call resolution links them to their declarations and their
effects propagate to the route. Swapping `listUsers` for a handler that deletes
is then a logic change that reports the write. The same holds for what `use`
and a mount hand over (`app.use("/admin", adminRouter)` calls `adminRouter`),
and for every registration of a chain. A call is added for what a name spells:
an identifier, a member path from a name, `handlers["list"]` as
`handlers.list`, inside arrays and spreads of arrays. An inline function is the
registration's own body, a factory (`requireRole("admin")`,
`asyncHandler(listUsers)`) is a call the registration already makes, and a
spread whose contents the statement does not show (`...guards`), a computed
member and a member of `this` name no Symbol, so none of them adds one. What a
factory is handed gets no call of its own: `asyncHandler(listUsers)` links
`asyncHandler`, not `listUsers`.

Not classified today (documented for completeness):

- A method added after a `.route(path)` chain's last, or its last dropped:
  `@aburi/lang-typescript` names the chain's Symbol after its outermost call,
  so `.get(getUser).put(requireAdmin, updateUser)` gaining `.delete(deleteUser)`
  is one Symbol removed and one added, which `--fail-on removed` counts.
- A `.route()` chain whose path is not a literal starting with `/`
  (`app.route(USERS_PATH).get(requireUser, listUsers)`): `route` is shared
  vocabulary (`db.route("users")`), so each method is read as a plain
  registration whose first argument is its path, and `requireUser` is neither
  middleware nor a call.
- A route handler declared on its own (`function getUsers(req, res) {…}`) keeps
  its own kind, a plain `function` Symbol. The registration that names it is
  the route, and calls it.
- Type-level inferences (whether a `Handler` typed function argument is an
  Express handler). The arity heuristic used here is the most reliable
  pre-LSP signal for a middleware / error-middleware split.
- A name a destructuring pattern pulls out of a `Router()` call
  (`const { stack } = Router()`) — the binding is not the Router, only
  something read off it.
- A route whose only handler is awaited (`app.get(p, await makeHandler())`) or
  constructed (`app.get(p, new AsyncHandler(h))`) — either is ordinarily data
  when handed to a `put` or a `post` (`axios.post(url, new FormData(form))`).
- An argument behind an old-style type assertion (`app.get(p, <RequestHandler>h)`,
  `app.use(<RequestHandler>logger)`) — `@aburi/lang-typescript` does not read
  through `<T>x` either, and the two readers have to agree.
- A route registered on a name an `app.route(path)` call was bound to
  (`const r = app.route("/users")`, then `r.get(h)`) — `r.get(h)` is shaped
  like `cache.get(key)`, and the plugin reads one statement at a time, so it
  cannot see where `r` came from.
- An `app.route(...)` chain whose path is not a literal beginning with `/`
  (`app.route(USERS_PATH).get(h)`) — `route` is shared vocabulary too, and a
  builder's `db.route("users").delete(id)` has the same shape.

## Install

```bash
pnpm add -D @aburi/framework-express
```

## Usage

```ts
import { expressFrameworkPlugin } from "@aburi/framework-express"
```

The plugin's `provides.frameworks: ["express"]` matches `@aburi/core`'s
Component autodetect against a workspace `express` npm dependency. Adding
`"@aburi/framework-express"` to `aburi.json`'s `frameworks` array wires it into
the scan pipeline.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:express:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
