---
"@aburi/core": minor
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/effects-trpc": minor
---

Classify the calls on a client another module of the workspace builds. `prisma.user.findMany()` after `import { prisma } from "./lib/db"`, `this.prisma.post.delete(…)` beside `constructor(private prisma: PrismaService)`, `db.insert(users)` after `import { db } from "./db"`, and `api.post.list.useQuery()` after `import { api } from "~/utils/trpc"` now get their effects, through barrels and `export *` alike, where the file imports nothing from the library itself. Before, each needed an import of the library in the calling file, so an `import type { User } from "@prisma/client"` added or removed beside the call made its `db.write` appear or vanish. Where only a module the file imports from uses the library, Prisma and Drizzle classify a call only on a receiver their client vocabulary names, and tRPC classifies nothing.

`effects-prisma` recognises a client generated to `generated/prisma` (`prisma init`'s default from Prisma 6.6, and Prisma 7's), with or without `/client`, `/edge` or `/browser`, every subpath of `@prisma/client`, and the `@prisma/adapter-*` and `@prisma/extension-*` packages. A client generated elsewhere is named in `pluginOptions["effects-prisma"].clientModules`, matched by its last path segments; an options value of any other shape fails the plugin's `init`.

A call whose receiver is declared with a class the workspace declares the called member on, such as `this.usersService.create(dto)`, is no longer handed to any effect plugin: it stays in `calls[]`, resolves to `UsersService.create`, and the write that method makes reaches the caller as a propagated effect. Before, a Prisma type imported in the controller made it a `medium` `db.write` and cut the edge to the service. A member inherited from a package class (`PrismaService extends PrismaClient`) is still the library's. Prisma and Drizzle grade a receiver declared with the library's own type (`db: PrismaClient`, `db: NodePgDatabase`) `high` whatever it is called.

`ImportEdge` gains `upstream`, which the scan sets on the edges effect plugins are handed: for each name an edge into the workspace binds, the specifiers the module declaring it imports. `ParseResult.imports` is typed `WrittenImportEdge[]`, the edge without the fields the scan sets. `@aburi/plugin-registry/plugin-input` gains `importGate`, `importBindingOf`, `receiverTypeFromMatchingModule` and `typedReceiverConfidence`.

On the pinned `cal-com` checkout, Prisma effects go from 0 to 2,384 and tRPC effects from 24 to 219. A file whose bodies make calls now has each workspace module it imports from read for its imports, once per extraction thread, so a scan with an effect plugin loaded takes longer: `cal-com` from 15.5 s to 18.6 s on four threads. A Symbol that gains an effect moves its `logic` fingerprint with no change to its source, so an `aburi diff` against an IR an earlier version wrote reports it as changed; one that scans both sides with this version does not.
