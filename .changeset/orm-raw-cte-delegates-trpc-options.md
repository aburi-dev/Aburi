---
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/effects-trpc": minor
"@aburi/cli": patch
---

`effects-prisma` reads MongoDB's `<client>.<model>.findRaw` as `db.read`, and declines its
`aggregateRaw`, whose pipeline can end in `$out` or `$merge`, under
`effects-plugin:prisma:raw-query`.

`effects-drizzle` declines the SQLite drivers' `db.run` / `all` / `get` / `values` under
`effects-plugin:drizzle:raw-sql`, with the receiver check `execute` has. A root built on a CTE
(`db.with(sq).select()`) reads its client past the `with`, so it is `high` as `db.select()` is.
A client segment no Drizzle client word names, behind one that names an ORM's client
(`prisma.user.delete`, `tx.user.update`, `this.prismaService.user.delete`), is another ORM's
delegate and is no longer claimed, so `effects-prisma` records those calls at `high` whichever
plugin the config lists first.

`effects-trpc` records `queryOptions`, `infiniteQueryOptions`, `mutationOptions` and
`subscriptionOptions` of the TanStack React Query integration as `network.rpc` at `medium`, tagged
by family and path as the hooks are, and its import gate opens on `@trpc/tanstack-react-query`,
which `aburi init` now suggests the plugin for.
