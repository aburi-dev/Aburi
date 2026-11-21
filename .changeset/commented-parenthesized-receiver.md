---
"@aburi/lang-typescript": patch
---

Read a parenthesized receiver or callee past a comment written inside the parentheses. `(/* c */ svc).save()` is `svc.save`, `(/* c */ prisma.user).delete()` is `prisma.user.delete`, and `(/* c */ f)()` and `new (/* c */ X)()` are `f` and `X`, where the comment used to be taken for the receiver or the callee and the call became the dynamic `<computed>.save` or `<computed>`, which call resolution could not follow and no effect plugin classified. A call written this way now resolves and is classified as its spelling without the comment is, so a Symbol that gains an effect from it moves its `logic` against an IR an earlier version wrote.
