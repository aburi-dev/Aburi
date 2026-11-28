---
"@aburi/framework-trpc": minor
---

A router names what each procedure written inside its object literal is built on, prefixed by the
path a client calls the procedure by (`delete:protectedProcedure`, and
`post.delete:protectedProcedure` through a router written inside it as `t.router({ … })`, a plain
object or a `mergeRouters` call), and calls each base procedure and middleware it names. Switching
an inline procedure from `protectedProcedure` to `publicProcedure` is now a logic change to the
router, reported as one `middleware` entry removed and one added, where it was syntax-only. The
entries are ordered by path, so swapping two keys is no logic change.
