---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/lang-typescript": minor
"@aburi/markdown-projection": minor
---

Read the conditions and values a body decides on into its `logic` fingerprint. Three rule types join the IR's `Rule.type`: `branch`, an `if` whose consequence does not leave early, by its condition (`if (user.isAdmin) openVault(user)`); `case`, a `switch` clause by its label, `default` for the default clause; and `value`, what a declaration holds rather than computes: a constant's initializer (`export const TIMEOUT_MS = 5000`), each entry of an object a constant holds that is not a Symbol of its own, and each member of an enum. A `loop` rule now carries its header as `condition`: a `while` or `do` loop's condition, or everything between a `for` statement's parentheses (`let i = 0; i < n; i++`, `const x of xs`). So `if (user.isAdmin)` → `if (!user.isAdmin)`, `i < n` → `i <= n`, `case "admin"` → `case "guest"`, `TIMEOUT_MS = 5000` → `5` and a changed, removed or reordered enum member or object key are logic changes, where before they were syntax-only and passed `--fail-on logic-changed`. A value that holds a function, a call, a `new` or an `await` anywhere in it is no `value` rule: what a call is handed moves `syntax` alone, in a constant as in any body.

The Markdown report writes the new rules as `branch: …`, `case: …`, `value: …` and `loop: … (for)`, and the folded Syntax-only section's summary now says its Symbols were `edited outside the API, rules, effects and middleware` rather than that nothing changed: an operator outside a rule, which function a call outside a rule calls, an `await` and a `break` that lets a `case` fall through still move `syntax` alone.

`logicNamesNothing` reads a `value`, `loop` or `branch` rule as naming nothing, since `true`, `const item of items` or `enabled` recur across unrelated declarations, and the diff groups such a Symbol by its shape, `logicShapeFingerprint`, a new export of `@aburi/core`: its declared values left out and every other rule's text removed. So a constant whose value changed, an enum that gained a member, and a body of branches whose condition changed still pair by name when they move file, while a deleted body of branches no longer pairs with an unrelated one added elsewhere.

The `logic` fingerprint moves once for every Symbol that has one of these rules, with no change to its source: 23% of the kept Symbols on the pinned `cal-com` checkout and 13% on `express`. An `aburi diff` against an IR an earlier version wrote reports them as changed; one that scans both sides with this version does not.
