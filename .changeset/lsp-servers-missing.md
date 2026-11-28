---
"@aburi/core": patch
---

`lsp.enabled: true` (or `--lsp`) with no `lsp.servers` block is now read as an empty block. The scan records `stats.lspEnrichment` with `enabled: false` and no requests, and reports that no language has a server under `lsp.servers`, as it already did for `servers: {}`. Before, the missing block skipped the pass without a word and left `stats.lspEnrichment` out.
