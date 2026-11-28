---
"@aburi/framework-react": minor
---

A capitalised function is a `framework:react:component` only when its own returns hand back what
React renders: an element or a fragment, an array of them, `children`, a `createElement` /
`cloneElement` / `createPortal` call, or a `.map` / `.flatMap` / `useMemo` whose callback hands one
back, read through conditionals, `&&` / `||` / `??` and the names the body binds. JSX elsewhere in
the body no longer makes one, so `Format(v)` returning a string, `renderToStaticMarkup(<p />)` and a
`GET` returning `new ImageResponse(<div />)` have no role. `hasJsxReturn` (and `returnsJsx`) read
the returned values the same way.
