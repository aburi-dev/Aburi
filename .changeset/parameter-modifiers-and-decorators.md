---
"@aburi/types": minor
"@aburi/lang-typescript": minor
"@aburi/core": minor
"@aburi/diff": patch
"@aburi/markdown-projection": patch
---

Record what a parameter is written with beside its type. A `Signature.inputs` entry gains `modifiers` (`public`, `private`, `protected`, `override`, `readonly`, in source order) for a constructor's parameter property and `decorators` (each as `Decorator.raw` reads it) for a decorated parameter, both omitted when there are none. The api fingerprint hashes them, so `constructor(private s: S)` turning `public s`, or `@Param("id")` turning `@Query("id")`, is an api change on the member where it used to move only its `syntax`. `aburi diff` names such an input as `modified`, and the report prints it as written: `@Inject(TOKEN) private readonly repo: Repo`.

A constructor with a parameter property and a method with a decorated parameter get a new `api` fingerprint with no change to their source: an `aburi diff` against an IR an earlier version wrote reports them as changed; one that scans both sides with this version does not.
