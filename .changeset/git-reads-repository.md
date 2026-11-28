---
"@aburi/core": patch
---

A `.git` now marks a checkout of its own only when git reads it as a repository: a directory whose `HEAD` names a ref or a commit, with `objects/` and `refs/` in it or in the directory its `commondir` names, or a `gitdir: ` file naming such a directory. Discovery, the language census and the workspace-root walk all use that test. A pointer left by a pruned worktree or a copied submodule, or an empty `.git` directory, used to leave every file beside it out of the scan without a word, while git listed them as the outer repository's.
