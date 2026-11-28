# @aburi/framework-react

React framework plugin for `@aburi/core`. Classifies React function components,
custom hooks, contexts, `forwardRef` / `memo` wrappers, context providers, and
higher-order components into `framework:react:*` extKinds so downstream tooling
can group them in the workspace projection.

Recognised shapes:

| Source shape | `extKind` | Signal |
|---|---|---|
| `function Widget() { return <div/> }` | `framework:react:component` | PascalCase name + JSX return |
| `const Widget = () => <div/>` | `framework:react:component` | PascalCase name + JSX return |
| `function useThing() { … }` | `framework:react:hook` | `/^use[A-Z]/` name |
| `function useX() { useState(…); … }` | `framework:react:hook` (+ `hook-call` signal) | naming + inner hook call |
| `const Ctx = createContext(…)` | `framework:react:context` | that const's own initializer is a `createContext(...)` / `React.createContext(...)` call that is React's |
| `const B = forwardRef((p,r) => …)` | `framework:react:forward-ref` | that const's own initializer is a `forwardRef(...)` / `React.forwardRef(...)` call that is React's |
| `const M = memo(Inner)` | `framework:react:memo` | that const's own initializer is a `memo(...)` / `React.memo(...)` call that is React's |
| `export default forwardRef((p,r) => …)` | `framework:react:forward-ref` | the default export is a `forwardRef(...)` call |
| `export default memo(function Row() { … })`, `export default memo(Row)` | `framework:react:memo` | the default export is a `memo(...)` call |
| `export default createContext(…)` | `framework:react:context` | the default export is a `createContext(...)` call |
| `function P() { return <Ctx.Provider>…</Ctx.Provider> }` | `framework:react:provider` | PascalCase + a returned `<X.Provider>` |
| `function withAuth(C) { … }` | `framework:react:hoc` | `/^with[A-Z]/` name + a body that renders JSX, or returns a function, a class or a call |

Priorities are first-match-wins in the order listed above: a `useX` function
that also returns JSX still classifies as `hook`, and a `<Ctx.Provider>`-shaped
component classifies as `provider` rather than `component`.

A role read off a name is `high` only in a file that imports React, and
`medium` elsewhere, which the report badges: `useCounter` is a Vue composable's
name too, and `memo` or `createContext` can be any library's. A file imports
React through any edge to `react`, `react/*`, `preact/compat` or
`preact/compat/*`: a type-only import, a re-export, a side-effect import, an
`import()` and a `require()` count, while `react-dom`, `react-router` and `preact` do not. That
covers a hook that calls no other hook, a bare context, memo or forward-ref
call no import binds, and a HOC that returns a function or a class without
rendering JSX.

A hook that calls another is `high` in any file, since calling one is what
makes a function a hook by React's rules, and a hook file often imports only
the hooks it builds on (`next/navigation`, `@tanstack/react-query`). A hook is
called by its name, on a PascalCase namespace (`React.useState()`) or on a
client's procedure path (`trpc.viewer.me.useQuery()`), while a lowercase
object's own method (`vi.useFakeTimers()`) is no hook call. In a file that
imports Vue or Solid (`vue`, `@vue/*`, `@vueuse/*`, `vue-router`, `pinia`,
`nuxt`, `nuxt/*`, `#app`, `#imports`, `solid-js`, `solid-js/*`, `@solidjs/*`)
no call is, because their composables are named as hooks are and call one
another.

JSX needs no import under the automatic runtime, so a component, a provider and
a HOC that renders JSX are `high` in any file, and so is a context, memo or
forward-ref call handed JSX.

The name alone makes no HOC. A `with*` function's body must render JSX or hand
back a component: a function or a class, written in the `return` or declared in
the body under the name returned (`const Themed = (p) => …; return Themed`).
In a file that imports React, a call handed back may give back one too
(`return memo(Inner)`, `return connect(mapState)(C)`,
`return hoistNonReactStatics(W, C)`), so that is a HOC at `medium`, unless the
call is made through one of the function's parameters. So `withRetry(fn)`,
which returns what `fn` resolves to, and `withTransaction(db, fn)`, which
returns `db.transaction(fn)`, have no role.

Nor does a factory's name make a wrapper on just any callee. A context, memo or
forward-ref call is React's through a name an import from React binds
(`React.memo(Inner)` beside `import React from "react"`, `R.memo` through
`import * as R from "react"`, `memo` through `import { memo } from "react"`),
through a bare name no import binds, or when handed JSX, which makes it wrap a
component whatever names the factory, as Chakra UI's own `forwardRef` does. So
`vm.createContext({})`, `createContext()` through `import { createContext } from
"solid-js"`, `cache.memo(compute)`, and `React.memo(Inner)` in a file that does
not import React have no role.

A const is read from its own declarator, so in
`export const PAGE_SIZE = 20, Row = memo(RowImpl)` only `Row` is a memo. The
initializer must be the wrapper call itself, read through `as`, `satisfies`,
`!` and parentheses as `@aburi/lang-typescript` reads it to name the Symbol
(`memo(Row) as typeof Row` is a memo), and its outermost call names the role,
so `memo(forwardRef(…))` is a memo. A const whose initializer only contains a
wrapper call (in an array or object literal, handed to another call or to
`new`, in one branch of a conditional), or that a destructuring pattern pulls
out of one, has no wrapper role: it holds that expression's value, not
necessarily the wrapped component. A default export written as a wrapper call,
handed a function or not, is a `const` named `<default>` to
`@aburi/lang-typescript`, and its value is read the same way.

That call is named in `derivedBy` by the name read off the syntax tree: the
name the callee's receiver chain starts from, read through the same wrappers,
and the name called. Beside `import React from "react"`, `React.memo(Inner)`,
`(React as any).memo(Inner)` and the same call wrapped over two lines or with a
comment before `.memo` all give `framework:react:memo:React.memo`, and
`memo(Inner)` gives `framework:react:memo:memo`. A receiver that is not a name
is `<computed>` (`new Registry().memo(() => <li />)`, a memo by the JSX it is
handed, gives `framework:react:memo:<computed>.memo`), so no entry carries the
source's line breaks, indentation or comments. A hook's `hook-call` signal
reads the name called the same way, so `React.useState(0)` wrapped after its
`.` or with a comment there still counts.

A function is a provider when any of its returns hands back a `<X.Provider>`
element, so a loading guard above it (`if (!user) return <Spinner />`) does not
make it a plain component. Every `return` in the function's own body is read,
and a concise arrow's body is its return; a `return` inside a nested function,
generator or method belongs to that function. The returned value is read
through `as`, `satisfies`, `!` and parentheses, into both arms of a conditional,
both sides of `||` and `??` (only the left when it is an element, which is never
falsy or nullish), and the last operand of `&&`. Only the returned element
itself is read, not the elements inside it.

Not classified today (documented for completeness):

- Class components (`class X extends React.Component`) — the plugin only
  targets function components; adding class support is a separate signal path.
- `"use client"` / `"use server"` directives — those are the `framework-next`
  plugin's responsibility.
- A provider that is not the returned element itself: one inside a fragment
  (`<><Ctx.Provider>…</Ctx.Provider></>`) or inside another element
  (`<ErrorBoundary><Ctx.Provider>…`), and one anywhere else in an expression
  the function returns, such as a call
  (`return items.map((item) => <Ctx.Provider>…</Ctx.Provider>)`,
  `return useMemo(() => <Ctx.Provider>…</Ctx.Provider>, deps)`,
  `return createPortal(<Ctx.Provider>…</Ctx.Provider>, el)`) or an array
  (`return [<Ctx.Provider …/>]`). Such a function is a `component`.
- React 19's `<Ctx value={…}>` provider spelling. The element names the
  context itself, which the plugin cannot tell from a component by its name,
  so the function is a `component`.
- Signals that require type-level information (whether a function's return
  type resolves to `ReactNode`, whether an HOC parameter is typed as a
  component). The JSX-body heuristic used here is the most reliable pre-LSP
  signal.
- A HOC that hands back a call, in a file that does not import React
  (`(C) => connect(mapState)(C)` under the automatic runtime): the call may
  give back anything, so the function has no role.
- React's factories through a module of the project's own
  (`import { forwardRef } from "@/lib/react"`): another import binds the name,
  so the call has no role unless handed JSX.
- A Vue or Solid composable in a file that imports neither, as Nuxt's
  auto-imports allow: calling another `use*` function makes it a `high` hook.
- A hook a lowercase client exposes as its own method (`trpc.useUtils()`): the
  call reads as that object's method, so a hook calling only it is graded by
  the file's imports.
- A wrapper behind an old-style type assertion (`<Context<T>>createContext(…)`,
  `<any>memo(Inner)`, written in a `.ts` file) — the initializer is read
  through `as`, `satisfies`, `!` and parentheses only, as
  `@aburi/lang-typescript` reads it to name the Symbol.

## Install

```bash
pnpm add -D @aburi/framework-react
```

## Usage

```ts
import { reactFrameworkPlugin } from "@aburi/framework-react"
```

The plugin's `provides.frameworks: ["react"]` matches `@aburi/core`'s Component
autodetect against a workspace `react` npm dependency. Adding
`"@aburi/framework-react"` to `aburi.json`'s `frameworks` array wires it into
the scan pipeline. `aburi init` writes it there (as `framework-react`) when it
detects a React dependency, and with `--with-suggestions` names
`@aburi/framework-react` and the command that installs it while the package is
not installed.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:react:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
