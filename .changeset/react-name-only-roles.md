---
"@aburi/framework-react": minor
---

Grade a role read off a name `medium` unless the file imports React, and give a `with*` function or a factory call a role only where it can hand back a component.

- A file imports React through any edge to `react`, `react/*`, `preact/compat` or `preact/compat/*`, a type-only import, a re-export, a side-effect import and `import()` included. Elsewhere these are `medium`: a hook that calls no other hook, a bare `createContext`, `memo` or `forwardRef` call no import binds, and a HOC that hands back a function or a class without rendering JSX.
- A hook that calls another stays `high` in any file. A call counts by its name, on a PascalCase namespace (`React.useState()`) or on a client's procedure path (`trpc.viewer.me.useQuery()`), but not as a lowercase object's own method (`vi.useFakeTimers()`), and none counts in a file that imports Vue or Solid, whose composables call one another.
- A `with*` function is a HOC when its body renders JSX (`high`), hands back a function or a class, written in the `return` or declared in the body under the name returned, or, in a file that imports React, hands back a call not made through one of its parameters (`medium`). `withRetry(fn)` and `withTransaction(db, fn)` have no role.
- A `createContext`, `memo` or `forwardRef` call is a role only through a name a React import binds, a bare name no import binds, or when handed JSX (`high`). `vm.createContext({})`, `createContext` from `solid-js`, `cache.memo(compute)` and `React.memo(Inner)` in a file that does not import React have no role.
- Confidence is part of a Symbol's status in `aburi diff`. Moving a file to the automatic runtime by deleting `import React from "react"` reports its name-read roles as changed, from `high` to `medium`.
- `classifyReactSymbol` takes the `FrameworkClassifyContext` the scan hands a framework plugin, since it reads the file's imports.
