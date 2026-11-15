---
"@aburi/types": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
---

Name a logic change that only reorders a Symbol's effects. `SymbolDelta` gains `effectsReordered`, true when the locally detected effects both sides hold, each read by `(id, target)`, run in a different order; propagated effects carry no order and are left out. The `logic` fingerprint reads effects in call order, so swapping `await a.save()` and `await b.log()` moved it while every effect paired and `delta.effects` held nothing: the report said `logic fingerprint changed; no field-level detail was recorded`, and `--fail-on logic-changed` tripped with nothing to say why. The report now writes ``- effects reordered: db.write `a.save`, log.write `b.log` → log.write `b.log`, db.write `a.save` `` after the effect rows. The field is optional in the schema so older diffs stay valid, and this version always writes it, `false` included.
