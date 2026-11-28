---
"@aburi/cli": minor
---

`aburi diff <base>..<head>` now scans the head it is given. A head that names the commit checked out is still read from the working tree, uncommitted changes included; any other head (`v1.2.0..v1.3.0` with neither tag checked out, or `origin/main..$SHA` in a checkout that is elsewhere) is checked out into a temporary worktree of its own, as the base is, and its warnings are labelled `head ref "<head>"`. Both scans still use the working tree's config, plugins and installed dependencies. A ref that names no commit, such as `HEAD^{tree}` or a tag of a tree, is refused at exit 2 before anything is checked out.

The rename map now describes the trees the scans read. For a working-tree head it is read from the base against the working tree, through a scratch copy of the index that also holds the files git does not track yet, so a file moved with `git mv` or a plain `mv` and not yet committed is reported as moved rather than removed and added, and no longer trips `--fail-on removed`. The caller's index is never written. An untracked file git cannot add to that copy, such as an untracked repository with no commit, is named in a warning, and the rest of the map is kept. The line-ending notes git prints while reading the working tree are the one thing it says there that is not passed on.

`GitRunner.run` takes an `env` option, typed `GitRunOptions`, for variables set on one command alone, and a runner must apply it: rename detection names its scratch index there, and when git answers with the caller's index instead it leaves the untracked files out, with a warning, rather than add them to that index.
