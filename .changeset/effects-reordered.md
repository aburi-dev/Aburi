---
"@aburi/types": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
---

Name a logic change that only reorders a Symbol's effects. `SymbolDelta` gains `effectsReordered`, true when the locally detected effects both sides hold appear in a different order, each read by its target as the `logic` fingerprint reads it; propagated effects, which the fingerprint reads sorted, are left out. The `logic` fingerprint reads effects in source order, so swapping `await prisma.account.update(…)` and `await prisma.audit.create(…)` moved it while every effect paired and `delta.effects` held nothing: the report said `logic fingerprint changed; no field-level detail was recorded`, and `--fail-on logic-changed` tripped with nothing to say why. The report now writes ``- effects reordered: db.write `prisma.account.update`, db.write `prisma.audit.create` → db.write `prisma.audit.create`, db.write `prisma.account.update` `` after the effect rows. The field is optional in the schema so older diffs stay valid, and this version always writes it, `false` included.
