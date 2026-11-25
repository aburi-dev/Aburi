---
"@aburi/lang-typescript": patch
---

Find a file's `import()` calls through the grammar's own search instead of a walk that built a node object for every node in the file. The edges are the same; parsing the pinned `cal-com` checkout's TypeScript files takes about a fifth less time (4.8 s → 3.9 s on one thread).
