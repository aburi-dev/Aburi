---
"@aburi/framework-react": patch
---

Document that a default export written as a wrapper call handed no function, `export default memo(Row)` or `export default createContext(…)`, is classified as `framework:react:memo` or `framework:react:context`, now that `@aburi/lang-typescript` gives it a `<default>` Symbol.
