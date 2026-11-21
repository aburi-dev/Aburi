---
"@aburi/lang-typescript": patch
---

Keep a function whose body is `{}` when a parameter default gives the walk a call or a rule. `export function g(x = f()) {}`, `class C { m(x = f()) {} }`, `class C { constructor(x = f()) {} }` and `handle = withAuth((x = count()) => {})` were dropped as `empty body`. A default is walked on the function's own Symbol, and outside a constructor, whose class also walks its whole parameter list, nowhere else, so for every one but the constructor the calls in the default went with it. They are now kept with those calls, so an `aburi diff` against an IR an earlier version wrote reports them as no longer dropped, and their callers pick up what the defaults call. A default that gives the walk nothing (`g(x = 1) {}`, `g({ a } = {}) {}`) still leaves the function dropped.
