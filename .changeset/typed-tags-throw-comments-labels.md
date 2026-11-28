---
"@aburi/lang-typescript": patch
---

Read three constructs the plugin read wrongly.

- A tagged template with type arguments is a call of its tag. ``prisma.$queryRaw<User[]>`…` `` was recorded as a call to `<computed>`, so `effects-prisma` never declined it as a raw query; it is now `prisma.$queryRaw`, as the untyped tag is. ``sql<number>`count(*)` ``, which the grammar reads as two comparisons, was no call at all; it is now a call of `sql`, so a workspace tag resolves. A union or a list of type arguments that the grammar reads as comparisons or a sequence still records no call.
- A comment right after `throw` is no longer read as the thrown value, so `throw /* legacy */ new NotFound()` keeps `NotFound` in `signature.throws` and in its `throw` rule. The same holds for a comment after a top-level `await`.
- A label's name is part of the normalized string, so swapping `break outer` and `break inner` moves `syntax`. Every Symbol whose body holds a label gets a new `syntax` fingerprint once.
