---
"@aburi/lang-typescript": patch
---

Keep the text a parser could not place in the normalized string. In a file with a syntax error, tree-sitter parks what it skips in an ERROR node marked as an extra, and every extra was left out with the comments, so an edit there (`export type T = | A B` → `| X B`, `save(a b)` → `save(a c)`, the text after a bare `&` in JSX) moved no fingerprint. Comments are now the only extras left out, and an ERROR holding only punctuation (a stray `)`) still changes nothing. A Symbol whose source holds such a part, a bare `&` in JSX text or a variance modifier (`class E<in out T>`) among them, gets a new `syntax` fingerprint, so an `aburi diff` against an IR an earlier version wrote reports it as syntax-changed once.
