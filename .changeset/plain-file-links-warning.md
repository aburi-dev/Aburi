---
"@aburi/cli": patch
---

`aburi diff <base>..<head>` now warns, for each side, about symbolic links that git checked out as plain files and that the scan then read as source. Discovery passes over a link, but git writes a link as a plain file holding its target while `core.symlinks` is false, and that is the usual setting on Windows. Changing the setting later leaves the files already checked out as they are. The check looks at what each checkout holds: the base worktree, and the head's working tree, which covers links the head adds and links checked out before the setting changed. It names only links that put a Symbol into that side's IR, so a link like `AGENTS.md -> CLAUDE.md`, or one to a directory, never triggers it. The warning also gives the remedy for that side. Previously the spec listed this check, but nothing ran it.
