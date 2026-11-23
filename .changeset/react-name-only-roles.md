---
"@aburi/framework-react": minor
---

Grade a role read off a name `medium` unless the file imports React (`react`, `react/*`,
`preact/compat`): a hook that calls no other hook, a context, memo or forward-ref call, and a HOC
that returns a function without rendering JSX. A `with*` function is a HOC only when its body renders JSX or returns a
function, so `withRetry(fn)` has no role. `createContext` called on a receiver is a context only
when an import from React binds the receiver, so `vm.createContext({})` has no role.
`classifyReactSymbol` takes the `FrameworkClassifyContext` the scan hands a framework plugin,
since it reads the file's imports.
