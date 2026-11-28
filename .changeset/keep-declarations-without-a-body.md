---
"@aburi/core": minor
"@aburi/types": minor
---

Keep an abstract method and a function or method declared under `declare` instead of dropping it as `empty body`, so a change to the signature it declares is reported under API changes. None of them may be written with a body: the signature is all it declares, and it is what a subclass or a caller is checked against. A function or method whose body is `{}` is still dropped.

A call reaches an abstract method as the type checker binds it: `this.find()` in a member of `abstract class Repo` and `repo.find()` through `repo: Repo` resolve to `Repo.find`, so its callers are listed beside an api change to it. A function or method under `declare` says the value is defined elsewhere, so no call resolves to it: the call goes on to the implementation another file declares, or stays unresolved, as it did while the declaration was dropped.

`@aburi/types` exports the two `derivedBy` entries as `ABSTRACT_DECLARATION_DERIVED_BY` and `AMBIENT_DECLARATION_DERIVED_BY`.

On the pinned `cal-com` checkout, 8 abstract methods are kept that were dropped before. Three calls that ended `dynamic` now resolve to one of them, and no other Symbol's fingerprint moves. An `aburi diff` against an IR an earlier version wrote reports the 8 as no longer dropped.
