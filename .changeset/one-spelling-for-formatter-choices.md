---
"@aburi/lang-typescript": minor
---

Write a rule's strings, a type and a decorator in one canonical spelling, so running a formatter moves no fingerprint. The text is rebuilt from the syntax tree's tokens instead of copied from the source: comments and line breaks are left out and the spacing between tokens is regenerated, a string that needs no escape is quoted with `"`, a quoted key that needs no quotes is written bare, a `,` before a closing bracket and a block's optional `;` are left out, an arrow's lone parameter is written in parentheses, a number's letter case and zeros are settled (`1.50` reads `1.5`), and parentheses are written where the grouping needs them or where readers mix operators up (`a && b || c` reads `(a && b) || c`) and left out elsewhere, including those a formatter wraps around JSX laid out over lines. JSX reads as React renders it: no space is added between children, and the line breaks and indentation around its text are dropped. So `'admin'` → `"admin"` in a guard no longer moves `logic`, a string literal type's quotes no longer move `api`, and `@Controller('users')` → `@Controller("users")` no longer lists the class and every method under API changes. Two programs never share a spelling: `'it\'s'` keeps its quotes, `(a + b) * c` its parentheses, and the text between JSX tags is content.

The syntax axis reads the same way: parentheses the grouping does not need, a quoted key's quotes, a number's spelling and the layout of JSX text no longer move `syntax`.

`Decorator.raw` and `Decorator.arguments` now hold the canonical spelling rather than the source text, so the report writes `@Post("/invoices")` for `@Post('/invoices')`.

The fingerprints move once for Symbols whose source was not already written this way, with no change to the source: on the pinned `cal-com` checkout, `api` for 204 of the 14,531 kept Symbols, `logic` for 2,326 and `syntax` for 2,045. An `aburi diff` against an IR an earlier version wrote reports them as changed; one that scans both sides with this version does not.
