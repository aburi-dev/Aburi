# @aburi/mcp

## 0.1.0

### Minor Changes

- 94d60cb: Add `@aburi/mcp`, an MCP server for AI coding agents. Its `scan`, `workspace`, `component`, `explain` and `diff` tools answer with what a run of the workspace's own `aburi` CLI prints and writes, one call at a time, writing only in a temporary directory of its own.

### Patch Changes

- 6e1e180: Declare `engines.node` as `>=24`, the Node.js version the documentation already requires, so a package manager can say so on an older Node instead of the package failing at run time.
- 6e1e180: Answer the `scan` tool with the census lines of `aburi scan` alone. The run also prints the path of each file it wrote, and those name a directory of the server's own that the caller cannot use; they are left out of the answer, for a workspace CLI of any version.
- Updated dependencies: `@aburi/cli@0.9.0`
