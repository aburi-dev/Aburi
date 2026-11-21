---
"@aburi/types": minor
"@aburi/core": minor
---

Let a framework plugin add the calls a framework makes on a Symbol's behalf that its body does not. `SymbolClassification.calls` lists them, each a `target` and the 1-based `line` the reference is written on, and `@aburi/core` appends the winning classification's to the Symbol's `calls[]`, after the body's calls on a line both share. They skip the Category C drop and the effect plugins, since no call is written there with arguments to classify, and resolve as the body's calls do: the callee's effects propagate to the Symbol, the Slice View joins the two when those effects change, and `aburi explain` lists the Symbol under the callee's Called by. A dropped Symbol carries none.

`SyntaxNode` now declares `startPosition`, which `asSyntaxNode` checks, so a framework plugin can read the line a node is written on. A language plugin whose nodes carry no numeric `startPosition.row` now hands framework plugins no node they can read, so its Symbols go unclassified.
