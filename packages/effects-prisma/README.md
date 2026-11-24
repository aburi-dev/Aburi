# @aburi/effects-prisma

Prisma effect plugin for `@aburi/core`. Classifies Prisma client calls into core
effect vocabulary so the IR can distinguish "reads the database" from "writes
the database" without needing to render every raw call.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `<client>.<model>.findUnique / findUniqueOrThrow / findFirst / findFirstOrThrow / findMany / count / aggregate / groupBy` | `db.read` |
| `<client>.<model>.create / createMany / createManyAndReturn / update / updateMany / updateManyAndReturn / upsert / delete / deleteMany` | `db.write` |
| `<client>.$transaction(...)` | `db.transaction` |

Raw queries (`$queryRaw` / `$queryRawUnsafe` / `$queryRawTyped` / `$executeRaw` /
`$executeRawUnsafe`, and MongoDB's `$runCommandRaw`) are intentionally **not**
classified: whether a raw query reads or writes is in the SQL or the command it
is handed, not in the call site.
The plugin declines it instead, so the call stays in `calls[]` and the IR's
`stats.declinedCalls` lists it under `effects-plugin:prisma:raw-query`, which
`aburi explain` shows under the Symbol's `## Declined effects`.

Layered gate: the file must reach a Prisma client module, which is
`@prisma/client` and its subpaths (`@prisma/client/edge`, …), a driver adapter
(`@prisma/adapter-*`) or client extension (`@prisma/extension-*`), a client
generated to `generated/prisma` (the `prisma init` default from Prisma 6.6, and
Prisma 7's: `../generated/prisma`, `…/generated/prisma/client`, `/edge`,
`/browser`), or a module the options below name. It reaches one by importing
it, or through a module of the workspace it imports from:

- **The module the call's client is imported from.** `import { prisma } from
  "./lib/db"`, where `lib/db.ts` builds the client, leads `prisma` to Prisma,
  whatever barrels lie between; through `export *`, only the target that
  exports `prisma` counts.
- **Another module the file imports from.** A NestJS service that injects
  `PrismaService` imports nothing from Prisma, but `./prisma.service` does.

Either way the module may export something else beside the client, so there a
call is classified only on a receiver the client vocabulary names or Prisma's
own type declares: `prisma.user.findMany()` and `this.prisma.user.create(…)`
are, and the same client imported as `store`, or `this.store.items.delete({
key })`, are not. The import that binds the call's client decides first, so an
`import type { User } from "@prisma/client"` beside it changes nothing.

A delegate call needs at least three
`.`-separated segments (`<client>.<model>.<verb>`), so a random `foo.findMany()`
call in an unrelated file will not false-classify; `$transaction` and the
raw-query methods need only a client segment (`<client>.$transaction`). A bare
`$transaction()` or `$queryRaw` without a client segment is skipped.

### Receiver identification

The import gate answers "does this file use Prisma", which a file is free to
answer yes to while most of its calls belong to something else. `delete`,
`create` and `update` are shared vocabulary across `Map`, `Set`, the DOM and
every HTTP router, and `this.<x>.<y>.delete(...)` is everyday TypeScript — so
the shape plus the gate is not evidence that the receiver is a database client.

Four further checks decide what is recorded:

- **Literal first argument.** A Prisma method takes an options object, an array
  or a callback — never a bare literal. `this.cache.items.delete("session")` is
  a `Map`, and is not classified at all.
- **Receiver name.** The segment before the model — `prisma` in
  `this.prisma.user.create`, `db` in `db.user.create` — is matched word-wise
  against the client vocabulary (`prisma` / `db` / `database` / `orm` / `tx` /
  `trx`), so `prismaClient`, `readReplicaDb` and `_prisma` all count and
  `cache`, `router`, `store` and `apiClient` do not. `client` is deliberately
  absent: a resource SDK's `<client>.<resource>.<verb>` is a delegate call's
  shape exactly, so the entry would hand `apiClient.users.update(payload)` the
  top tier.
- **Model name.** A Prisma model is named after a table, so a model segment
  that is exactly a word an ORM binds its client to (Prisma's client words and
  Drizzle's `drizzle`, `conn` and `connection`) is not one, unless a Prisma
  client stands in front of it. `this.db.delete(auditLog)` is Drizzle's
  `<client>.<verb>` with `this` in front, and is not classified at all, which
  leaves it to `effects-drizzle` in a file that imports both, while
  `prisma.tx.create(…)` is a `Tx` model. The match is exact, so a `txLog` or
  `ormMapping` model still counts.
- **Argument count.** A delegate takes at most one argument, `$transaction`
  two. More than that is evidence against — but only evidence: `argumentCount`
  is a syntactic count, and a drop would erase a real write without logging
  anything, so an overflow costs the tier instead.

A call that passes the literal-argument and model-name checks, whose receiver
names a client and whose arguments fit, gets `confidence: "high"`; anything
short of that still records the effect, at `confidence: "medium"`.

The `medium` tier is deliberate. Without the AST — which effect plugins never
see — a client bound under a house naming convention and an unrelated object of
the same shape are indistinguishable from the callee string, so the uncertainty
is stated rather than resolved by guessing. A receiver the language plugin
flagged as dynamic (`getPrisma().user.create()`) is capped at `medium` for the
same reason: the name in the target is a collapsed expression, not a binding.

Naming your client something this vocabulary does not know is not an error — it
costs the effect its `high` tier, and the table in `src/receivers.ts` is one
literal list if a house convention deserves to be in it.

A receiver declared with a type `@prisma/client` binds, or one a workspace
barrel re-exports from it, is the client whatever it is called, and gets `high`
on that alone. The receiver is the object the method is called on: beside
`private store: PrismaClient` that is `this.store` for `$transaction` and the
raw queries, while `this.store.user.findMany()` calls a delegate no declaration
types and is graded by the name `store`, as above. A delegate declared as one
(`private users: Prisma.UserDelegate`) places `this.users.findMany()`.

A call of a method your own class declares is never Prisma's:
`this.usersService.create(dto)` beside `constructor(private usersService:
UsersService)` stays in `calls[]`, resolved to `UsersService.create`, and the
write that method makes reaches the caller as a propagated effect, whether the
module exports the class by its name, as its default or under another name.

## Options

A generator `output` other than `generated/prisma` puts the client in a module
the plugin cannot know. Name it under `pluginOptions` in `aburi.json`:

```json
{
  "effects": ["effects-prisma"],
  "pluginOptions": {
    "effects-prisma": { "clientModules": ["db/client"] }
  }
}
```

An entry matches an import whose last path segments are the entry's, an
extension and an `index` file left off, so `"db/client"` matches
`"../db/client"`, `"@/db/client.ts"` and `"../../db/client/index"`. An options
value of any other shape stops the scan with an error that names the key.

## Install

```bash
pnpm add -D @aburi/effects-prisma
```

## Usage

```ts
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)
