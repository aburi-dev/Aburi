# @aburi/plugin-process

Drives a parser or classifier written in another language from a JavaScript Aburi plugin: one
long-lived process per scan (one per parser worker, when the scan extracts on several), answering
JSON-RPC requests over stdio. A plugin for Python or Go can
then use `go/packages` or a Python type checker instead of syntax alone, and stays an ordinary
plugin to the core.

## Install

```bash
pnpm add @aburi/plugin-process
```

## Usage

```ts
import { createPluginProcess, type PluginProcess } from "@aburi/plugin-process"

let parser: PluginProcess

export const plugin = {
  // manifest (with its languageId), fileExtensions, capabilities …
  async init(ctx) {
    parser = createPluginProcess({ command: "python3", args: ["-m", "my_parser"], cwd: ctx.workspaceRoot })
    try {
      await parser.request("initialize", { workspaceRoot: ctx.workspaceRoot })
    } catch (error) {
      // A plugin whose init fails is not cleaned up, so it ends what it started.
      await parser.close()
      throw error
    }
  },
  async cleanup() {
    await parser.close()
  },
  async parseFile(file) {
    const tree = (await parser.request("parse", file)) as MyTree
    return { tree, errors: tree.errors, imports: tree.imports }
  },
  // extractSymbols, walkBody and normalizeAst read the JSON tree the process answered with.
}
```

The scan calls `init` before its first file and `cleanup` after its last plugin call, so the
process lives as long as the scan. `createPluginProcess` starts nothing; the first request does.
Awaiting one in `init` makes a parser that cannot run end the scan with exit `3`, naming the
plugin, instead of withdrawing every file of its language.

## The other end

One JSON-RPC 2.0 message per line, UTF-8:

```
→ {"jsonrpc":"2.0","id":1,"method":"parse","params":{"path":"src/app.py","content":"…"}}
← {"jsonrpc":"2.0","id":1,"result":{…}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"…"}}
```

Answers may come in any order. Anything else on stdout is a fault, so diagnostics go to stderr.
The process exits when its stdin closes.

A minimal Python peer:

```python
import json, sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

for line in sys.stdin:
    request = json.loads(line)
    answer = {"jsonrpc": "2.0", "id": request["id"]}
    try:
        answer["result"] = handle(request["method"], request.get("params"))  # your parser
    except Exception as error:
        answer["error"] = {"code": -32000, "message": str(error)}
    print(json.dumps(answer), flush=True)
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `command`, `args` | — | Started with no shell, so a `.cmd` or `.bat` on Windows is named as `cmd.exe` with `/c` and the script first among the args |
| `cwd` | the host's | The process's working directory |
| `env` | the host's | Variables set over the host's environment; one set to `undefined` is left out |
| `timeoutMs` | `30000` | How long a request may wait, the start included, at most 2^31−1 ms; `request(method, params, { timeoutMs })` overrides it for one |
| `maxResponseBytes` | 256 MiB | The longest line the process may write |

## Failures

A failed request rejects with a `PluginProcessError` whose `code` is one of `error-response`,
`exited`, `timeout`, `oversize`, `protocol`, `start-failed`, `abandoned` or `closed`;
`isPluginProcessError` tells one apart even across two copies of the package. An `error-response`
carries the process's error object, `code` and `data` included, on `rpcError`, and keeps the
process. Thrown from `parseFile`, any of them withdraws that one file and the scan goes on.

A process that crashed, timed out or wrote something other than an answer is replaced by the next
request; after three in a row end without answering anything, requests fail with `abandoned` until
`close`. An idle process never keeps its host alive; one being ended does, until it exits.

## See also

- [`docs/design/plugin-process.md`](../../docs/design/plugin-process.md) — the contract.
- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the plugin lifecycle.
