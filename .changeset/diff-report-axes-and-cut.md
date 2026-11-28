---
"@aburi/markdown-projection": minor
"@aburi/cli": patch
"@aburi/github-action": patch
---

`diff.md` says which fingerprint moved when nothing it shows explains it. Each row now explains only the axes whose fingerprint reads its field, and each flagged axis no row explains gets its own `- <axis> fingerprint changed; no field-level detail was recorded`, so a logic row beside an API change no row records no longer hides the API one. A Symbol whose `kind` or `extKind` changed gets a row for each (``- kind: `function` → `class` ``, ``- extKind: `framework:react:component` → none``).

Under `--max-bytes`, a section of whole Symbols too long to fit even as names is no longer omitted outright: after every other section is placed, it lists as many of its names as the room left holds, in order, under a line saying how many of how many, and ends with `- … and N more`. The note names such sections under **Cut short**. A diff removing 1,200 functions now names 1,184 of them in a 65507-byte comment, where it named none.
