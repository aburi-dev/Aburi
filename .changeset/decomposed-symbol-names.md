---
"@aburi/core": patch
---

A Symbol's `name`, and the name an `export-clause:` token in its `derivedBy` gives, are now NFC-normalized when a plugin hands them over, as its id, call targets and signature already were. A name saved in decomposed Unicode, an `e` followed by a combining accent, used to give a Symbol whose id and name spelled it differently, and a call to it from a file that spelled it composed never resolved.
