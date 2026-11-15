---
"@aburi/lang-typescript": patch
---

Read a parenthesized receiver past a comment written inside the parentheses. `(/* c */ svc).save()` is `svc.save` and `(/* c */ prisma.user).delete()` is `prisma.user.delete`, where the comment used to be taken for the receiver and the call became the dynamic `<computed>.save`, which call resolution could not follow and no effect plugin classified. A call written this way now resolves and is classified as its spelling without the comment is, so a Symbol that gains an effect from it moves its `logic` against an IR an earlier version wrote.
