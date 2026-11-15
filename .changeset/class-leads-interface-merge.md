---
"@aburi/lang-typescript": patch
---

A class merged with an interface of the same name leads the merged Symbol whichever is written first. `interface Emitter { … }` above `class Emitter implements Emitter { … }` used to give an `interface` Symbol, dropped as a data model, with `new Emitter()` resolving to nothing; it is now a kept `class` with the class's range and body, the interface folded in so an edit to it still moves the class's `syntax`. A type alias above a binding that holds a class (`type R = InstanceType<typeof R>` above `const R = class { … }`) gives way the same way. The order with the class first is unchanged.

Such a Symbol changes kind, range and fingerprints once: an `aburi diff` against an IR an earlier version wrote reports it as changed (or as added, where the interface was dropped); one that scans both sides with this version does not.
