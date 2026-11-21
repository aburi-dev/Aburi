---
"@aburi/types": minor
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/diff": patch
"@aburi/markdown-projection": patch
---

Record what a parameter is written with beside its type. A `Signature.inputs` entry gains `modifiers` (`public`, `private`, `protected`, `override`, `readonly`, in source order) for a constructor's parameter property and `decorators` (each as its text after `@` reads on one line, so a formatter breaking its arguments over lines changes nothing) for a decorated parameter, both omitted when there are none. The api fingerprint hashes them, a parameter's decorators sorted as a Symbol's are, so `constructor(private s: S)` turning `public s`, or `@Param("id")` turning `@Query("id")`, is an api change on the member where it used to move only its `syntax`. `aburi diff` names such an input as `modified`, comparing its decorators in any order, refuses an IR whose `modifiers` or `decorators` is not a list of strings, and the report prints the input as written: `@Inject(TOKEN) private readonly repo: Repo`.

A constructor with a parameter property and a method with a decorated parameter get a new `api` fingerprint with no change to their source: 29 of the 5,580 Symbols in this repository, every one a constructor or a NestJS handler, and no `logic` or `syntax` fingerprint moves. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
