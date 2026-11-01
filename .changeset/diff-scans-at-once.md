---
"@aburi/cli": minor
---

`aburi diff <base>..<head>` runs its two scans at the same time: the base on a worker thread, the
head on the main thread. On a 4-CPU machine a diff of the last 50 commits of `nest` (1,828
TypeScript files) took 4.4 s instead of 6.9 s, where one scan of the head takes 3.4 s, and peak RSS
rose from 362 MiB to 498 MiB. stdout, stderr, the exit code and the report stay byte-identical to a
run with one scan at a time. That includes which failure ends a run where a scan fails: the base
scan's error still comes first, and the head's log and incidents still follow the base's. A plugin
that ends the base's thread itself, by calling `process.exit()` or throwing from a timer, ends the
run with exit 1 and a message naming the base ref.

The new `--no-parallel-scans` option (`DiffOptions.parallelScans: false`) runs the base and then the
head, as before, which uses less memory. Without it, both scans run together when
`os.availableParallelism()` reports two or more CPUs; `--parallel-scans` runs them together on one.
