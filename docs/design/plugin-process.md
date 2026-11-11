# Plugin Processes

The contract of `@aburi/plugin-process`: the helper a JavaScript plugin drives a parser or
classifier written in another language with, as one long-lived process that answers JSON-RPC
requests over stdio.

See: [`lang-plugin.md`](./lang-plugin.md) §3 (the lifecycle that opens and closes it), §4.2 (the
opaque tree), §7 (what a failed file costs), §8 (parser options)
Implementation: [`packages/plugin-process`](https://github.com/kage1020/Aburi/tree/main/packages/plugin-process)

---

## 1. Purpose

Tree-sitter WASM parses Python and Go, but what needs more than syntax lives in tools written in
those languages: module resolution the way `go/packages` does it, the types a Python checker
infers. A plugin is a JavaScript module the CLI loads into its own process, so it cannot call
them. This package lets it run one as a process of its own and ask it about each file.

It adds nothing to the plugin contract. The plugin is still a JavaScript plugin, loaded,
registered and called the way every other one is; the process is a detail of how it computes its
answers. The tree `parseFile` returns is already the plugin's own type, so it can be the JSON the
process answered with, and `extractSymbols`, `walkBody` and `normalizeAst` read that tree in the
plugin's process.

## 2. Usage

```ts
import { createPluginProcess, type PluginProcess } from "@aburi/plugin-process"

let parser: PluginProcess

export const plugin: LanguagePlugin<PythonTree, PythonNode> = {
  // manifest (with its languageId), fileExtensions, capabilities …
  async init(ctx) {
    parser = createPluginProcess({ command: "python3", args: ["-m", "aburi_python"], cwd: ctx.workspaceRoot })
    try {
      await parser.request("initialize", { workspaceRoot: ctx.workspaceRoot }, { timeoutMs: 60_000 })
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
    const tree = (await parser.request("parse", file)) as PythonTree
    return { tree, errors: tree.errors, imports: tree.imports }
  },
  extractSymbols: (tree, ctx) => tree.symbols.map((node) => candidateOf(node, ctx)),
  walkBody: (symbol) => bodyOf(symbol.bodyNode),
  normalizeAst: (symbol) => symbol.fullNode.normalized,
}
```

`createPluginProcess(options)` starts nothing. The first request starts the process, so a scan with
no file of the language never does. A first request from `init` is where a parser that cannot run
ends the scan with exit `3`, naming the plugin, rather than withdrawing every file of its language;
it also keeps an expensive start-up out of the first file's `parseTimeoutMs`.

| Option | Default | Meaning |
|---|---|---|
| `command`, `args` | — | Run as `spawn` runs them, with no shell between, so a `.cmd` or `.bat` on Windows is named as `cmd.exe` with `/c` and the script first among the args; named itself, it fails with `start-failed` saying so |
| `cwd` | the host's | The process's working directory |
| `env` | the host's | Variables set over the host's environment, each replacing the host's variable of that name (in any case, on Windows); one set to `undefined` is left out |
| `timeoutMs` | `30000` | How long one request may wait for its answer, the process's start included. `request(method, params, { timeoutMs })` overrides it for one request. A value above 2^31−1 (about 24.8 days) waits that long |
| `maxResponseBytes` | `268435456` (256 MiB) | The longest line the process may write on stdout |

Both numbers must be positive integers; anything else is a `RangeError` from
`createPluginProcess`, or from the `request` that passed it.

## 3. Protocol

JSON-RPC 2.0 messages, one per line, UTF-8, each ending in `\n`:

```
→ {"jsonrpc":"2.0","id":1,"method":"parse","params":{"path":"src/app.py","content":"…"}}
← {"jsonrpc":"2.0","id":1,"result":{"symbols":[…],"imports":[…],"errors":[]}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"cannot parse src/bad.py"}}
```

- The methods and the shape of `params` and `result` are the plugin's own. The helper sends what
  `request` is given and resolves with `result` as it was parsed.
- `params` is left out of a request `request` was not given params for.
- Answers may come in any order; each is matched to its request by `id`. A plugin may have several
  requests in flight. The core calls one plugin object for one file at a time; a scan that extracts
  on parser workers holds a plugin object, and so a process, on each.
- A line ending in `\r\n` is read as one ending in `\n`, and a blank line is ignored. A response
  may leave out `"jsonrpc"`.
- **Every other line on stdout is a fault**: a line that is not JSON, not an object, carries no
  numeric `id`, carries an `id` no request is waiting on, has neither `result` nor `error` or has
  both, or has an `error` that is not an object with an integer `code` and a string `message`.
  Diagnostics go to stderr, which the helper keeps the last 8,192 characters of and otherwise
  ignores.
- The process is to exit when its stdin closes. That is what it sees when its host exits, and how
  the helper first asks it to end (PP-2).

## 4. Failures

Rule PP-1: **a failed request rejects with a `PluginProcessError`**, whose `code` says how it
failed and whose message names the command line. Thrown from `parseFile`, it withdraws that one
file as an extraction failure ([`lang-plugin.md`](./lang-plugin.md) §7.2), with the code and the
message on `ScanResult.extractionFailures`, and the scan goes on.

| `code` | When | The process |
|---|---|---|
| `error-response` | The process answered with `error`: `<command> answered <method> with an error: <error.message>`, the error object, `data` included, on the error's `rpcError` | Kept |
| `exited` | The process ended with requests waiting: `<command> exited with code <n>` or `ended on <signal>`, then `. Its stdin had closed: <reason>` if it stopped reading its requests, and `. It wrote on stderr:` and its stderr's tail, if any. A request still waiting when another one's timeout ended the process gets it too, naming that request | Gone |
| `timeout` | No answer within `timeoutMs`: `<command> did not answer <method> within <n>ms` | Ended |
| `oversize` | A line passed `maxResponseBytes` | Ended |
| `protocol` | A line on stdout that answers no request (§3), quoted to its first 200 characters | Ended |
| `start-failed` | The command could not be started, whether `spawn` refused it outright or reported it: `Could not start <command>: <reason>` | — |
| `abandoned` | See PP-3 | Not started |
| `closed` | `close` was called before the request was answered | Ended |

Rule PP-2: **a process that has ended is replaced by the next request**, so one file that kills
the parser costs that file alone: the request that met the fault, and any others in flight with
it, are rejected, and the next file is parsed by a fresh process. A process the helper ends has its
stdin closed and a second to exit; then it is sent `SIGTERM`, and `SIGKILL` five seconds later if
it is still running. On Windows either signal ends the process at once (`TerminateProcess`), so the
second after its stdin closes is all the warning it gets there. Five seconds after `SIGKILL` the
helper stops waiting. Once the process has exited, its pipes have a second to close: a launcher
that runs the parser without `exec`ing it leaves the parser holding them, and the helper closes its
own ends and leaves that parser running.

Rule PP-3: **after three processes in a row end without answering a request, no fourth is
started.** Every request after them rejects at once with `abandoned`, quoting the last one's end,
until `close` is called. A parser that cannot start, or dies on its first line of input, would
otherwise be started again for every file of a scan.

## 5. Lifetime

Rule PP-4: **`close` ends every process the helper started**, the one running and any it is still
ending, and resolves once they have exited. A request still waiting rejects with `closed`. A
request after `close` starts a new process, so a plugin object scanned twice opens and closes one
per scan through `init` and `cleanup`. A scan extracting on parser workers loads the plugin on
each, so it runs one process for each worker ([`lang-plugin.md`](./lang-plugin.md) §3).

Rule PP-5: **an idle process does not keep its host alive.** The process and its pipes are
detached from the host's event loop; only a waiting request's timer holds it, and a process being
ended until it has exited (PP-2), so a host awaiting `close` sees it resolve. A host that never
calls `close`, or that the user interrupts, still exits; the process then reads the end of its
stdin and exits too.

## 6. Verifiable Properties

| ID | Input | Expected |
|---|---|---|
| PP1 | `request("request", { file: "a.py" })`, then `request("request")` to a process that answers with the line it read | `{"jsonrpc":"2.0","id":1,"method":"request","params":{"file":"a.py"}}`, then the same with `"id":2` and no `params` |
| PP2 | Three requests at once, answered last-sent first, one with `\r\n` | Each resolves with its own result, from one process |
| PP3 | An `error` answer | `error-response` with its message, and its `code` and `message` on `rpcError`; the process kept |
| PP4 | The process exits, hangs past `timeoutMs`, writes a line over `maxResponseBytes` in one read or over several, or writes a line that is not an answer | `exited` with the stderr tail, `timeout`, `oversize`, `protocol`; the process gone and the next request answered by a new one |
| PP5 | The process exits with another request in flight | Both rejected with `exited` |
| PP6 | A process that exits on start, asked four times, then closed and asked again | `exited` three times, `abandoned` without a fourth start, then a start after `close` |
| PP7 | A command that does not exist | `start-failed` |
| PP8 | `close` with a request in flight, and with a process that holds `SIGTERM` and outlives its stdin | `closed`; each process gone; a later request starts a new one. `SIGTERM` ends any process at once on Windows, so Linux and macOS are where the escalation to `SIGKILL` runs |
| PP9 | `timeoutMs` `0` or `1.5` for the helper, `0` for one request, `maxResponseBytes` `-1`; `timeoutMs` 2^53−1 for the helper and 2^32 for one request | `RangeError` naming the option; requests answered after 50 ms |
| PP10 | A host that makes one request and never calls `close` | The host exits `0`, and the process after it |
| PP11 | A language plugin whose parser is a process, over a workspace scanned twice | One process per scan, gone when the scan ends, and the same IR both times |
| PP12 | The same plugin over a file its parser exits on | That file withdrawn with `exited`; the next file parsed by a new process |
| PP13 | An answer of over a megabyte whose multi-byte characters straddle the reads | Resolved whole |
| PP14 | A line that is `null` or an array, has a string `id`, neither or both of `result` and `error`, an `error` that is no object or has no integer `code`, or an `id` no request waits on | `protocol`; the process ended |
| PP15 | Two processes that end without answering, one that answers before it exits, then two more that end without answering | The next request starts a process and is answered (PP-3 counts ends in a row) |
| PP16 | A command `spawn` refuses outright, such as an empty one | `start-failed` three times, then `abandoned` |
| PP17 | `close` while a process a timeout ended is still ending, with a second one running, both holding `SIGTERM` | Resolves once both have exited |
| PP18 | A process that closes its stdin and keeps running | The next request rejects with `exited`, `Its stdin had closed:` and the reason. A Node process cannot close its stdin on Windows, so Linux and macOS are where this runs |
| PP19 | `close` of `sh -c "<parser> --hold; true"` | Resolves, the parser left running (PP-2) |
| PP20 | A host whose last step awaits `close` of a process that holds `SIGTERM` | The host exits `0` after `close` resolves, with the process gone |
| PP21 | `env` setting one variable and `PATH` to `undefined` | That variable set, `PATH` unset (on Windows, the host's `Path` too), the host's other variables as they were |
| PP22 | `isPluginProcessError` over its own error, one from another copy of the package, one so named with another code, another error, and an object that is no error | `true` for the first two |

## 7. Design Decisions

### 7.1 Why a helper, not a second kind of plugin

A plugin kind whose manifest names a command, with the core speaking the protocol, would put a
second implementation of every plugin method behind the boundary, each to be kept in step with
the in-process one: the tree, the candidates, the body walk, the classification. The tree a
language plugin hands the core is already opaque, so the boundary can sit inside the plugin, where
the plugin decides what crosses it — a whole tree per file, or one request per symbol — and the
core sees an ordinary plugin. Effects and framework plugins can use the helper the same way.

### 7.2 What carries across the boundary

- **The same IR from the same input.** The core reads the tree only through the plugin's methods,
  and the helper matches every answer to its request, so the IR depends on what the process
  answers and not on when. A process whose answers depend on more than its input (its own
  parallelism, an unordered map serialised as it stands) makes the IR vary, as a plugin doing the
  same in JavaScript would.
- **Withdrawal and timeouts.** A request that fails withdraws one file, as any throw from
  `parseFile` does. `parseTimeoutMs` still bounds a file's extraction, since it is read after
  `parseFile` returns; `timeoutMs` bounds a process that would never answer, which the core's
  cooperative budget cannot catch.
- **Recoverable parse errors** are part of what the process answers: the plugin returns them on
  `ParseResult.errors`, and the core reads them as it reads any plugin's.

### 7.3 Why one process per scan, not per file

Starting an interpreter costs tens of milliseconds, a type checker loading a module graph seconds;
once per file, that is minutes over five thousand files. One process answers every file, and only
a fault replaces it.

### 7.4 Why JSON-RPC over lines

It is the framing MCP's stdio transport uses, so Python and Go have libraries that speak it, and
a parser with none writes it in a few lines: read a line, write a line. A length prefix, as LSP
uses, would take a parser more code to frame and gain nothing a JSON text without raw newlines
needs.
