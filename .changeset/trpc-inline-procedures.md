---
"@aburi/framework-trpc": minor
---

A router names what each procedure written inside its object literal is built on, prefixed by the
key it is served under (`delete:protectedProcedure`, `post.delete:protectedProcedure` for a nested
router), and calls those base procedures and middleware. Switching an inline procedure from
`protectedProcedure` to `publicProcedure` is a logic change to the router that names both, where it
was reported as syntax-only.
