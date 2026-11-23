---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/markdown-projection": minor
---

Read the conditions and values a body decides on into its `logic` fingerprint. Three rule types join the IR's `Rule.type`: `branch`, an `if` whose consequence does not leave early, by its condition (`if (user.isAdmin) openVault(user)`); `case`, a `switch` clause by its label, `default` for the default clause; and `value`, what a declaration holds rather than computes: a constant's initializer (`export const TIMEOUT_MS = 5000`), each entry of an object a constant holds that is not a Symbol of its own, and each member of an enum. A `loop` rule now carries its header as `condition`: a `while` or `do` loop's condition, or everything between a `for` statement's parentheses (`let i = 0; i < n; i++`, `const x of xs`). So `if (user.isAdmin)` → `if (!user.isAdmin)`, `i < n` → `i <= n`, `case "admin"` → `case "guest"`, `TIMEOUT_MS = 5000` → `5` and a changed or removed enum member are logic changes, where before they were syntax-only and passed `--fail-on logic-changed`. A constant holding a call or a `new` still leaves its arguments to the call.

The Markdown report writes the new rules as `branch: …`, `case: …`, `value: …` and `loop: … (for)`, and the folded Syntax-only section's summary now says its Symbols were `edited outside the API, rules, effects and middleware` rather than that nothing changed: an operator outside a rule, which function a call calls, an `await` and a `break` that lets a `case` fall through still move `syntax` alone.

`logicNamesNothing` reads a `value` or `loop` rule as naming nothing, since `true`, `0` or `const item of items` recur across unrelated declarations, so the diff pairs a constant, an enum or a body that is one loop by its name as it did before.

The `logic` fingerprint moves once for every Symbol that has one of these rules, with no change to its source: 24% of the kept Symbols on the pinned `cal-com` checkout and 19% on `express`. An `aburi diff` against an IR an earlier version wrote reports them as changed; one that scans both sides with this version does not.
