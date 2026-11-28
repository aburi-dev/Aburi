# @aburi/framework-next

Next.js framework plugin for `@aburi/core`. Recognises the App Router special
files by path convention and classifies them into `framework:next:*` extKinds
so downstream tooling can group them (e.g. surface every `page` as a boundary
in the workspace projection).

Recognised files under the App Router directory: `app/` or `src/app/` directly in the
project, which is the root of the file's Component (the workspace root for a file no Component
holds). A Component rooted inside an App Router directory (`apps/shop/src/app/checkout`) is
routed from that directory. An `app` anywhere else (`lib/app/`, or a package itself named `app`
in `apps/app/`) is no App Router. A private folder (`_components`) opts itself and every folder
under it out of routing, as Next.js does, while `%5F` stands for a routed `_`.

| File | `extKind` |
|---|---|
| `page.{ts,tsx,js,jsx}` | `framework:next:page` |
| `layout.{ts,tsx,js,jsx}` | `framework:next:layout` |
| `template.{ts,tsx,js,jsx}` | `framework:next:template` |
| `loading.{ts,tsx,js,jsx}` | `framework:next:loading` |
| `error.{ts,tsx,js,jsx}` | `framework:next:error` |
| `not-found.{ts,tsx,js,jsx}` | `framework:next:not-found` |
| `route.{ts,tsx,js,jsx}` | `framework:next:route` |

A component role (`page` through `not-found`) is the file's default export, written
`export default function Page()`, `export default Page` or `export { Page as default }`.
A default export written as a call handed a function (`export default withAuth(function Page() { … })`)
is one too, and so is a default-exported `const` initialised by such a call
(`const Page = withAuth(() => { … })` with `export default Page`). A `const` whose call is
handed no function (`const Page = withAuth(Inner)`) gets no role.

A route is what `route.{ts,tsx,js,jsx}` exports under an HTTP verb name (`GET`, `POST`, `PUT`,
`DELETE`, `PATCH`, `OPTIONS`, `HEAD`). Next.js dispatches to the module's exports by name, so
the plugin reads the export, not the declaration's name:

| Written | Routes |
|---|---|
| `export async function GET() {}` | `GET` |
| `export const GET = async () => …` | `GET` |
| `export const { GET, POST } = handlers` (Auth.js) | `GET`, `POST` |
| `export const GET = auth(async (req) => …)` | `GET` |
| `async function POST() {}` with `export { POST }` | `POST` |
| `const handler = NextAuth(options)` with `export { handler as GET, handler as POST }` | `GET` and `POST`, both on the one Symbol `handler` |
| `function OPTIONS() {}`, not exported | none |
| `function GET() {}` with `export type { GET }` | none: a type-only export is erased at runtime |
| `export { GET, POST } from "@/auth"` (Auth.js v5 beta) | none: a re-export declares nothing in the route file, so there is no Symbol to classify |
| `function GET() {}` with CommonJS `module.exports = { GET }` | none: only ESM exports are read |

A declaration exported only as `default`, or from inside a namespace, is not a route either.
The handler is a `function` Symbol where the language plugin can see its value is a function,
and a `const` where it cannot (a destructuring, a call's result). Both get the one extKind
`framework:next:route`, so a consumer filtering on it sees every route; its manifest
`baseKind` is `function`, what Next.js calls, and the Symbol's `kind` stays the language
plugin's reading. Export clauses are read by `@aburi/lang-typescript`, which records the name
each clause exports a declaration under.

The names a declaration is exported under are an input of its `api` fingerprint, so a
clause-exported handler gaining or losing a verb (`export { handler as GET }` becoming
`export { handler as GET, handler as DELETE }`) is an API change in `aburi diff`, reported with
the export names it gained and lost. A handler exported by its keyword is named by its verb, so
changing the verb reports it as removed and added.

Every role, `route` included, accepts `.ts`, `.tsx`, `.js` and `.jsx`, the extensions Next.js
matches App Router files against by default: an Open Graph image handler renders JSX, so it is
written as `app/api/og/route.tsx`. List `framework-next` ahead of `framework-react`, as `aburi
init` does: the first framework plugin to classify a symbol wins, and framework-react files a
capitalised function that renders JSX, such as that `GET`, as a component.

The middleware Next.js runs ahead of matched requests is `framework:next:middleware`: the
`middleware` export, or the default export, of `middleware.{ts,tsx,js,jsx}`, and the `proxy`
export, or the default export, of `proxy.{ts,tsx,js,jsx}` (the name from Next.js 16 on), each
directly in the project or in its `src/`. Its `config` export is not classified.

Not classified today (documented for completeness): `default`, `global-error`,
`instrumentation`, and the metadata files (`sitemap`, `icon`, `opengraph-image`, …). Adding
them is a table extension inside `app-router.ts`.

The calls that never return are guards. `redirect`, `permanentRedirect`, `notFound`, `forbidden`
and `unauthorized` from `next/navigation` throw on every call (`forbidden` and `unauthorized`
answer 403 and 401 only under `experimental.authInterrupts`, and throw a plain error without it),
so the manifest declares them under `provides.exitCalls`, and an `if` whose consequence calls one
is recorded as a `guard` rule, as `if (!session) throw …` is:

```tsx
import { notFound, redirect } from "next/navigation"

export default async function AdminPage({ params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user.isAdmin) redirect("/login") // guard
  const report = await loadReport(params.id)
  if (!report) notFound() // guard
  return <Dashboard user={session.user} report={report} />
}
```

Removing either check is then a logic change in `aburi diff`. The call is read through its import
(an alias, `import * as nav` or `import nav = require("next/navigation")` included), so a local
function named `redirect` is not one.

Client / server discrimination folds into `derivedBy`: a `"use client"` or `"use server"` directive
at the top of an App Router file adds `framework:next:client-component` or
`framework:next:server-action` to the Symbols classified above.

A server action is `framework:next:server-action`: what a module whose first statement is
`"use server"` exports, at any path (`app/orders/actions.ts`, `src/actions/posts.ts`,
`lib/actions.ts`), since the client can call each export. That is an exported async function
(`export async function`, `export const f = async () => …`, a clause or default export), or a
`const` initialised by a call handed a function, as `actionClient.action(async () => …)` is.
An action declared inside a component with a function-level `"use server"` stays part of that
component.

The plugin classifies only the files of a Component whose `frameworks` include `nextjs`, or
that records none, so a `"use server"` module in a package with no Next.js dependency is left
alone.

## Install

```bash
pnpm add -D @aburi/framework-next
```

## Usage

```ts
import { nextFrameworkPlugin } from "@aburi/framework-next"
```

`aburi init` writes `"framework-next"` into `aburi.json` under `frameworks`,
which is the plugin manifest name the loader resolves (to `@aburi/framework-next`
via the bare-name prefix — see
[`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md)). The short
framework id `"nextjs"` that component autodetect uses stays inside
`components[].frameworks`; the two fields carry different vocabularies and no
hand-editing is needed.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:next:*`) plug into the shared vocab.
