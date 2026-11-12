---
"@aburi/plugin-process": minor
---

Add `@aburi/plugin-process`, which drives a parser or classifier written in another language from a JavaScript plugin: one long-lived process per scan answering JSON-RPC requests over stdio, with a per-request timeout, a response size cap, a fresh process for the next request after one crashes or times out, and an end to retrying after three in a row end without answering. Closing ends every process it started, closing stdin first and then signalling, and holds the host until they have exited. A failed request is a `PluginProcessError`, recognised by `isPluginProcessError` across package copies, carrying the process's JSON-RPC error on `rpcError` when it answered with one.
