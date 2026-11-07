---
"@aburi/core": minor
"@aburi/cli": patch
---

The workspace root now honours a working tree whose repository is kept elsewhere. While `GIT_DIR` or `GIT_WORK_TREE` is set, the CLI asks git for the top of the working tree (`git rev-parse --show-toplevel`) and roots there: at the top `GIT_WORK_TREE` or `core.worktree` names, or, with neither set, at the directory it runs in, as git does, unless a `.git` lies above it. A bare repository, which has no working tree, leaves the walk as it was. `detectWorkspaceRoot` takes git's answer as the new `workTree` option (`GitWorkTree`: `{ top }` or `"start"`) and stops at that top the way it stops at a `.git`, meeting it as the ancestor of the start with the same real path. So `aburi diff <base>..<head>` on such a working tree, with a workspace marker above it, no longer roots the head above the base worktree and reports every Symbol as moved under the work tree's name.
