---
"@aburi/mcp": patch
---

`aburi-mcp` exits 2 at startup when `--cwd` does not exist or is not a directory, and a call made after that directory was removed fails naming it rather than the Node binary. A scan's files now live in a directory named after its id, so a `diff` of `scan-1` and `scan-2` names those two in its title whatever ran between them. The output schemas mark `scan` and `components` optional, so a failed call's structured result conforms to its tool's schema.
