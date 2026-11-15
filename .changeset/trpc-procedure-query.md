---
"@aburi/effects-trpc": minor
"@aburi/types": patch
---

Decline a `query` by its chain instead of by the file's `@trpc/server` import. A `query` whose chain starts from a name that is `procedure` or ends in `Procedure`, or reads a `procedure` segment (`publicProcedure.input(s).query(fn)`, `t.procedure.query(fn)`), is declined in any file as `effects-plugin:trpc:procedure-query`, the convention `@aburi/framework-trpc` reads a procedure by. Every other `query` of three or more segments is classified as the client call it is shaped like, so `client.user.byId.query({ id })` in a file that also imports `@trpc/server` — a server-side test, a script, a Next.js file beside an adapter import — is now `network.rpc` where it used to be declined. The `effects-plugin:trpc:server-file-query` reason is no longer written. A base procedure bound under another name (`const authed = t.procedure.use(auth)`) and queried in a file that imports a tRPC client reads as a client call.
