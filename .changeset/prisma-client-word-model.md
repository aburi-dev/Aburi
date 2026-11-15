---
"@aburi/effects-prisma": patch
---

Leave a delegate-shaped call whose model segment is a client word (`prisma`, `db`, `database`, `orm`, `tx`, `trx`) unclassified. In a file that imports both Prisma and Drizzle, `this.db.delete(auditLog)` read as `<client>.<model>.<verb>` with `db` as the model and was claimed as Prisma's `db.write` at `medium`, ahead of Drizzle's `high` claim whenever `effects-prisma` was listed first. It now reaches `effects-drizzle`, which records it with its own plugin, confidence and `derivedBy`. The match is exact, so a model such as `txLog` is still Prisma's.
