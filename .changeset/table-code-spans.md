---
"@aburi/markdown-projection": patch
---

Keep a backslash in front of a pipe as written inside a table's code spans, and a value of spaces alone whole in a code span

A call target or a component root holding `\|` showed up in the `aburi explain` call-resolution table and the `workspace.md` Components table with one backslash too many: the cell doubled the backslash run in front of a pipe, as if GFM paired backslashes there, and GFM takes exactly one off every `\|` in a row, code spans included. `tableCell` now gives every pipe exactly one backslash, so a code span holds the value byte for byte and the text around it reads as it does outside a table. It finds a cell's code spans as CommonMark does, to write a line ending inside one as the space CommonMark reads it as rather than `<br>`, and it drops a backslash in front of a line ending, which made the cell show a literal `<br>`: the break is what that backslash asked for.

`inlineCode` no longer pads a value made of spaces alone, which CommonMark keeps whole, so `" "` renders as one space rather than three.
