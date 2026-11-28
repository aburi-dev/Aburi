# @aburi/effects-drizzle

Drizzle ORM effect plugin for `@aburi/core`. Classifies Drizzle client calls
into core effect vocabulary so the IR can distinguish "reads the database"
from "writes the database" without needing to render every raw call.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `<client>.select() / selectDistinct() / selectDistinctOn()` (root of a fluent chain) | `db.read` |
| `<client>.query.<table>.findMany / findFirst` (relational query API) | `db.read` |
| `<client>.insert(...) / update(...) / delete(...)` (root of a fluent chain) | `db.write` |
| `<client>.with(cte).select() / insert(...) / ...` (a root built on a CTE) | as the root |
| `<client>.transaction(...) / batch(...)` | `db.transaction` |

### Fluent chain handling

Drizzle is a fluent builder — `db.select().from(u).where(w).orderBy(o)` — where
only the root call is the semantic anchor for the effect. The language plugin
emits one CallCandidate per link (`db.select`, `db.select.from`,
`db.select.from.where`, ...). The classifier keeps this a
**one-classification-per-chain** invariant by rejecting any target whose
internal segments contain a root verb (`select` / `selectDistinct` /
`selectDistinctOn` / `insert` / `update` / `delete`). Only the 2-segment root
survives and is anchored to the query origin line.

### Raw SQL and other unclassified surfaces

`.execute()`, and the SQLite drivers' `.run()` / `.all()` / `.get()` /
`.values()`, are intentionally **not** classified — a raw SQL call can be
either a read or a write, and which one is in the SQL, not in the call site.
On a receiver named like a Drizzle client (`db.execute(sql…)`,
`tx.execute(…)`, `db.run(sql…)`), the plugin declines it instead: the call stays in `calls[]`
and the IR's `stats.declinedCalls` lists it under
`effects-plugin:drizzle:raw-sql`, which `aburi explain` shows under the Symbol's
`## Declined effects`. This mirrors how `@aburi/effects-prisma` treats
`$queryRaw` / `$executeRaw`.

A root built on a CTE (`db.with(sq).select().from(sq)`, target
`db.with.select`) is read as the root it leads to, with the client one segment
further back: `db.with.select` is `db.read` at `high`, as `db.select` is. The
CTE's own `db.$with("sq").as(…)` names no statement. `.$count()` is not in the
vocabulary.

### Layered gate

A file that imports `drizzle-orm` (or any driver subpath like
`drizzle-orm/postgres-js` / `drizzle-orm/node-postgres` / `drizzle-orm/d1` /
`drizzle-orm/neon-http` / ...) is a prerequisite. Files that never pull in
Drizzle are ignored outright. The import gate uses a **prefix match** rather
than a closed allowlist because Drizzle publishes 20+ driver-specific subpaths
and adds new drivers per release.

The import may be made by a module of the workspace the file imports from:
`import { db } from "./db"`, where `db.ts` calls `drizzle(…)`, whatever barrels
lie between (through `export *`, only the target that exports `db` counts), or
any other module the file imports from that uses Drizzle (a schema, a
repository). Such a module may export something else beside the client, so
there a call is classified only on a receiver the client vocabulary names or a
Drizzle type declares: `db.insert(users)` is, and `usersRepo.update(id, dto)` on
a repository instance `./users.repo` exports is not.

### Receiver identification

The import gate is not a receiver check: it answers "does this file use
Drizzle", and an Express router file is free to answer yes — Express + Drizzle
is one of the most common pairings there is, and `router.delete("/users/:id", h)`
has the same 2-segment shape as `db.delete(users)`. Three further checks decide
what is recorded, and the last of them has a floor:

- **Literal first argument.** A Drizzle root takes a table reference, a
  projection object, a callback or a statement array — never a bare literal. So
  `router.delete("/users/:id", handler)` and `store.select("name")` are not
  classified at all.
- **Receiver name.** The client segment — `db` in `db.select`, in
  `this.db.select` and in `db.query.users.findMany` — is matched word-wise
  against the client vocabulary (`drizzle` / `db` / `database` / `conn` /
  `connection` / `orm` / `tx` / `trx`), so `drizzleDb`, `readReplicaDb` and
  `_db` all count and `router`, `store`, `cache` and `httpClient` do not.
  `client` is deliberately absent: it would hand `httpClient.delete(url)` the
  top tier, which is the collision this check exists to catch.
- **Argument count.** Most roots take one argument; `selectDistinctOn(columns,
  projection)` and `transaction(callback, config)` take two, and the table in
  `src/methods.ts` says so. More than the terminal takes is evidence against —
  but only evidence: `argumentCount` is a syntactic count, and a drop would
  erase a real query without logging anything, so an overflow costs the tier
  instead. Fewer is different for the terminals that require an argument —
  `insert`, `update` and `delete` take a table, `transaction` a callback and
  `batch` a statement array: a zero-argument `firestore.batch()`, an unmanaged
  `sequelize.transaction()`, a class's own `this.update()` or a form's
  `form.delete()` is not classified at all, whatever the receiver, and neither
  is `db.delete()`. Those calls have owners other than Drizzle, and a call the
  parser counts at zero (`db.transaction(/* cb */)`) is source that does not
  run.

A match on all three gives `confidence: "high"`; anything short of that, other
than a literal first argument or a zero-argument call to a terminal that
requires one, still records the effect, at `confidence: "medium"`.

The `medium` tier is deliberate. Without the AST — which effect plugins never
see — a client bound under a house naming convention and an unrelated object of
the same shape are indistinguishable from the callee string, so the uncertainty
is stated rather than resolved by guessing. A receiver the language plugin
flagged as dynamic (`getDb().select()`) is capped at `medium` for the same
reason: the name in the target is a collapsed expression, not a binding.

Naming your client something this vocabulary does not know is not an error — it
costs the effect its `high` tier, and the table in `src/receivers.ts` is one
literal list if a house convention deserves to be in it. A receiver declared
with a type a `drizzle-orm` module binds (`db: NodePgDatabase`) gets `high`
whatever it is called; one declared with a type the workspace declares
(`type Db = typeof db`) is read by its name, as above.

A client in front of a segment no client word names is another ORM's
`<client>.<model>.<verb>`, so `prisma.user.delete(…)`, `tx.user.update(…)` and
`this.prismaService.user.delete(…)` are not classified in a file that imports
both: plugins are asked in config order and the first claim wins, so a
`medium` claim here would hide `@aburi/effects-prisma`'s `high`. The client
words in front are Drizzle's and `prisma`, matched word-wise. Drizzle's own
`this.db.delete(table)` and `ctx.db.update(table)` have a client word in the
client segment and are classified as before.

A call of a method your own class declares is never Drizzle's:
`this.repo.update(id, dto)` beside `constructor(private repo: UsersRepo)` stays
in `calls[]`, resolved to `UsersRepo.update`, and the write that method makes
reaches the caller as a propagated effect.

## Install

```bash
pnpm add -D @aburi/effects-drizzle
```

## Usage

```ts
import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)
