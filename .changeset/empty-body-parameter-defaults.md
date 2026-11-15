---
"@aburi/lang-typescript": patch
---

Keep a function whose body is `{}` when a parameter default holds a call or a rule. `export function g(x = f()) {}`, `class C { m(x = f()) {} }` and `handle = withAuth((x = count()) => {})` were dropped as `empty body`, and the calls in their defaults with them, since a default is walked on the function's own Symbol and nowhere else. They are now kept with those calls, so an `aburi diff` against an IR an earlier version wrote reports them as no longer dropped, and their callers pick up what the defaults call. A default that calls nothing (`g(x = 1) {}`) still leaves the function dropped.
