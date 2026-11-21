---
"@aburi/effects-prisma": patch
---

Leave a delegate-shaped call whose model segment is a client word unclassified, unless a Prisma client stands in front of it. The words are Prisma's own (`prisma`, `db`, `database`, `orm`, `tx`, `trx`) and Drizzle's `drizzle`, `conn` and `connection`. In a file that imports both Prisma and Drizzle, `this.db.delete(auditLog)` read as `<client>.<model>.<verb>` with `db` as the model and was claimed as Prisma's `db.write` at `medium`, ahead of Drizzle's `high` claim whenever `effects-prisma` was listed first. It now reaches `effects-drizzle`, which records it with its own plugin, confidence and `derivedBy`. The model is matched exactly, so a model such as `txLog` is still Prisma's, and a client in front keeps a model named after a client word Prisma's: `prisma.tx.create(…)` writes to a `Tx` model.
