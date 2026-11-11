# Parallel Parsing Architecture

**Status: implemented.** `aburi scan` — and the scans `aburi diff` and `aburi explain` run — extracts files on a pool of worker threads sized to the machine and to the source, and on its own thread under `--concurrency 1` or when the source is too small to repay a worker (Rule PF-2). This document specifies that pool: how it is sized, what crosses between a worker and the main thread, how the main thread folds the workers' answers so the scan writes and says exactly what one thread would, and what happens when a worker ends under a file. It refines, but does not replace, the concurrency interface in [cli-spec.md](./cli-spec.md) §14.2 and the WASM lifecycle rules in [lang-plugin.md](./lang-plugin.md) §8.1. No IR schema change and no config field; the one flag is `--concurrency`.

## References:

- [cli-spec.md](./cli-spec.md) §9 — exit codes.
- [cli-spec.md](./cli-spec.md) §10 — progress reporting.
- [cli-spec.md](./cli-spec.md) §14.1 — the two scans of `aburi diff`, which share the machine.
- [cli-spec.md](./cli-spec.md) §14.2 — `--concurrency` and the per-worker heap budget.
- [lang-plugin.md](./lang-plugin.md) §4.3 — the `Symbol` and `SymbolCandidate` shape returned from `parseFile`.
- [lang-plugin.md](./lang-plugin.md) §4.8 — the import resolver each worker creates for itself.
- [lang-plugin.md](./lang-plugin.md) §7.2 — the per-file boundary a file a worker ended under is withdrawn through.
- [lang-plugin.md](./lang-plugin.md) §8 — parser implementation options table.
- [lang-plugin.md](./lang-plugin.md) §8.1 — WASM memory-management rules that this document refines.
- [overview.md](./overview.md) §2 — parser layer decision (tree-sitter core + optional LSP).
- [overview.md](./overview.md) §4 — the extraction pipeline this document parallelizes.
- [lsp-enrichment.md](./lsp-enrichment.md) §5 — LSP-level concurrency (a separate axis).
- [call-resolution.md](./call-resolution.md) CR24 — the byte-identical-output invariant style this document adopts.
- [ir-schema.md](./ir-schema.md) §3 — canonical sort order for `symbols[]` and `dependencies[]`.
- [roadmap.md](../roadmap.md) — Later: >1000 files in 30 s target.

---

## 1. Purpose

The roadmap sets a concrete target: >1000 files in 30 seconds on 4 cores / 8 GiB. A single thread already meets it on real repositories (§2.1), so the pool is not what makes Aburi fit the pull request loop; it is what keeps a large workspace's scan from growing with its file count on a machine with processors to spare. It preserves four invariants:

1. **Byte-identical output**: `aburi scan --concurrency 1` and `aburi scan --concurrency N` write identical IR JSON bytes for the same input, for any `N`, and say the same on stdout and stderr (Rule PF-11).
2. **Failure isolation**: a worker that ends under one file costs that file, not the others' results (§8).
3. **Memory safety**: the pool is sized so that every worker's declared WASM budget fits in the memory the runtime reports free (Rule PF-2).
4. **The single-threaded path is the reference implementation**: correctness debugging always has a deterministic linear execution to fall back to, and it runs the code a worker runs (§11).

## 2. Reference project shape

The roadmap target is measured against a specific benchmark corpus so CI can regress against it. Any change to the corpus is a documented event.

| Attribute | Value |
| --- | --- |
| File count | 1,200 TypeScript files (`.ts` + `.tsx`) |
| Avg tokens per file | 800 |
| Component count | 8 (avg 150 files/component, skew ratio ~3×) |
| Framework mix | NestJS controllers (30%), React components (30%), plain modules (40%) |
| LSP available | No (parse-only benchmark; LSP enrichment is a separate phase per §10) |
| Runner | 4 vCPU, 8 GiB RAM, cold disk cache |
| Wall time SLA | ≤ 30 s |
| Peak RSS SLA | ≤ 2 GiB |

The corpus itself is stored under `benchmarks/perf-1k/` (added in a follow-up PR that also adds the CI job). The corpus is generated deterministically from templates so its structure is reproducible without vendoring 1,200 files.

The corpus is deliberately many small files, which is the shape the pool exists for — and it is therefore blind to the opposite shape. A single generated file holding thousands of declarations sits inside `maxFileSizeBytes` and is one unit of work, so no amount of concurrency touches it: its cost is whatever the language plugin charges per file in the number of declarations ([lang-plugin.md](./lang-plugin.md) §8.2), and the run is not finished until the worker extracting it is. A wall-time regression on the corpus and a wall-time regression on one large file are separate measurements, and passing PT1 says nothing about the second.

### 2.1 What the same SLAs measure on real repositories

The corpus above does not exist yet. Nine public repositories at pinned commits do, under [`benchmarks/public-repos/`](https://github.com/kage1020/Aburi/blob/main/benchmarks/public-repos/README.md), and they carry the same two numbers. On a 4 vCPU / 16 GiB runner, single-threaded, the 2026-09-01 sweep finished 1,081 files in 3.7 s, 1,914 in 3.9 s and 5,002 in 14.7 s, and no *scan*'s peak RSS passed 466 MiB — the diffs in the same sweep, which run two scans each, reached 822 MiB. Cost is roughly linear in file count: a least-squares fit over the nine gives 2.8 ms per file plus 326 ms of fixed grammar-load and config cost, though the residuals are wide enough (`nest` 45% under the fit, `zod` 34% over) that the fit predicts an order of magnitude rather than a wall time.

That prices this document rather than retiring it. On Aburi's own repository (878 files, 4 processors) the pool takes a scan from 6.0 s to 3.9 s — 1.5×, short of the 3× three workers would ideally give, because each worker loads every plugin again and a file costs about 1.4× on a worker what it costs inline (§14.8) — on a workload that already finishes inside both SLAs. The scan worth being impatient with was `aburi diff`'s, which ran two of them at a measured 1.7–2.2× a single scan; those two are *independent* scans, which is a cheaper parallelism than sharding one, and they now run at once ([cli-spec.md](./cli-spec.md) §14.1), each on its share of the processors (Rule PF-2).

Rule PF-11 (§7.1) is measured on both halves. Three consecutive `aburi scan --no-timestamp` runs over an unchanged tree produced byte-identical IR on all nine repositories, and on Aburi's own repository every `--concurrency` from 1 to 4 wrote the same IR; §13 tests the second half as PT2.

## 3. Worker model — decision

| Option | Adopted | Rejected, and why |
| --- | --- | --- |
| Node `worker_threads` pool | ✔︎ | — |
| `child_process` fork pool |  | IPC uses stdout/stderr streams; serializing 1,200 files' worth of `SymbolCandidate[]` back through pipes adds measurable overhead vs. `postMessage` structured clone. Also loses the ability to share `ArrayBuffer` transferable regions if a future optimization needs it. |
| Single-threaded `Promise.all` |  | Tree-sitter parsing is CPU-bound synchronous work inside a single WASM instance. `Promise.all` yields no parallelism — all promises resolve on the same event loop. |
| Native `libuv` thread-pool via a native binding |  | Requires a native binding per platform; conflicts with the "npm install works everywhere" property. Reserved for the future via `capabilities.preferNative` (lang-plugin §8.1). |

Rule PF-1: the pool is Node `worker_threads`. Each worker loads every plugin the scan loaded — from the same config, with the command line's overrides, the same workspace root and the same root plugin references resolve against — and extracts the files it is handed one at a time, in the order it was handed them, until the scan's extraction ends. A plugin is loaded anew on each worker, since a loaded module cannot cross threads.

Rule PF-2: the pool size is

```
max(1, min(wanted, memory, source, files))
  wanted = --concurrency, or max(1, ceil((processors - 1) / scansAtOnce))
  memory = floor(availableMemoryMiB / scansAtOnce / heapPerWorkerMiB)
  source = floor(sourceBytes / 256 KiB) without --concurrency, no limit with it
  files  = the file count
```

- `processors` is `os.availableParallelism()` and `availableMemoryMiB` is `process.availableMemory()`: the free memory the runtime reports, already net of what the OS holds, not the machine's nominal RAM.
- `heapPerWorkerMiB` is the largest `capabilities.wasmHeapPerWorkerMB` among the loaded language plugins, a plugin that declares none counting as 256 (cli-spec §14.2), since any worker may be handed any file.
- `scansAtOnce` is 2 for each of `aburi diff`'s two scans when they run at once ([cli-spec.md](./cli-spec.md) §14.1) and 1 otherwise. The scans share the machine, so each is sized to half its memory, whatever `--concurrency` asks for, and by default to half its spare processors.
- `sourceBytes` is the size of every discovered file. Without `--concurrency`, a worker is started only for each 256 KiB of source, below which the worker costs more than the extraction it takes off the others (§14.8). `--concurrency` is the caller's own measurement, which the source does not lower.
- Neither starts more workers than there are files, as a worker with no file to extract is all cost.
- `--concurrency` is a ceiling the memory rule still applies to: `--concurrency 8` with room for four workers starts four.
- A pool of one is no pool: the scan extracts every file on its own thread (Rule PF-18).

At `--log-level debug` the scan says what it chose and from what — `scan: extracting on 3 parser workers (4 processors, 1200 files of 9600 KiB, 15000 MiB free at 256 MiB a worker)`, with `--concurrency 8` in place of the processors when it was given and `shared by 2 scans` after it under `aburi diff`. A default that leaves the scan on its own thread says nothing, since that line would change with the machine on every small scan's log.

## 4. Work partitioning

Rule PF-3: shards are file-level, not component-level. Component-level shards were considered and rejected: components skew (in the reference corpus, the largest component is 3× the median), and a component-level shard would idle N-1 workers for the duration of the largest component.

Rule PF-4: files are handed out in file order to the worker with the fewest in flight, at most two on each (§6.3), and a worker that answers is handed the next. Which worker extracts which file follows load and is not deterministic, and need not be: the main thread folds every answer in file order (§7.2), and nothing a file's extraction produces depends on the worker that ran it (§7.2.1), so the assignment reaches no output.

Rule PF-5: component detection ([component-detect.md](./component-detect.md)) runs **before** the pool starts. It is fast (single-threaded, small memory footprint), and its output, with the discovered files and the config, is the job every worker is spawned with. The pool is never asked to detect components.

Rule PF-6: the job — the discovered files in file order, the config with the command line's overrides, the Components — is computed once on the main thread and passed by structured clone to each worker at spawn time. A worker builds the language router, the component attribution and the drop-list filter ([drop-list.md](./drop-list.md)) from it and from the plugins it loaded, as the main thread builds them from the same two. None of it changes during the scan.

## 5. Serialization boundary

The `postMessage` boundary determines which values may cross between workers and the main thread. Getting this wrong causes both correctness bugs (dangling WASM node handles) and performance regressions (serializing 100 KB per file × 1,200 files).

### 5.1 Main → worker

A worker is spawned with the job (Rule PF-6) and what to load the plugins from, and is then sent one message per file:

```ts
interface ParserData {                         // workerData, at spawn
  job: {
    workspaceRoot: string;                     // absolute
    files: DiscoveredFile[];                   // a file is named by its index here
    config: Config;
    components: Component[];
  };
  setup: { config: Config; workspaceRoot: string; pluginRefRoot: string };
}

type ToWorker =
  | { kind: "extract"; fileId: number }
  | { kind: "close" };                         // clean up the plugins after the file in hand (Rule PF-9a)
```

No source text crosses the boundary. The worker reads the file from disk itself. Rationale: the main thread already enumerated the file list (needs the paths); reading the source there too would double the FS I/O.

### 5.2 Worker → main

```ts
type FromWorker =
  | { kind: "ready"; said: PluginLine[] }      // the plugins are loaded and initialized
  | { kind: "failed"; thrown: ThreadThrown; said: PluginLine[] }  // they could not be (Rule PF-15a)
  | { kind: "extracted"; extraction: WireExtraction }
  | { kind: "rejected"; fileId: number; thrown: ThreadThrown }   // extracting it rejected
  | { kind: "closed"; said: PluginLine[] };    // the plugins are cleaned up (Rule PF-9a)

interface PluginLine {                         // logged by a plugin's init or cleanup
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

interface WireExtraction {
  fileId: number;
  outcome:
    | { kind: "unroutable" }
    | { kind: "vanished"; detail: string }     // deleted since discovery
    | { kind: "threw"; message: string; code?: string }
    | { kind: "fatal"; thrown: ThreadThrown }  // ends the run
    | { kind: "ran"; result: FilePipelineResult; content: string;
        undeclaredVocab: UndeclaredVocabOccurrence[] };
  events: ExtractionEvent[];                   // what the file's extraction said, in order
}
```

A worker answers for its files in the order it was handed them. The events are what the file's extraction would have logged on one thread — its per-file log lines, its import resolver's lines and failures, the trees whose release failed — recorded instead of logged, so that the main thread says them in file order (§7.2). An error that ends the run crosses as a described copy, and only as one: the main thread rebuilds it with the class name, message and code of it and of each error it was caused by, so it ends the run as it would have on one thread. A file whose extraction rejects rather than answering — which on one thread ends the run with that error — crosses as `rejected` with its error described the same way, and the main thread rejects that file's extraction with the error rebuilt, so the fold ends the run at that file (§7.2 step 3) with the error one thread ends it with. The worker goes on to its next file: `failed` says only that the plugins could not be loaded or initialized.

Rule PF-7: what a worker returns is data. The file's pipeline result holds its Symbols — the fully-normalized shape of [lang-plugin.md](./lang-plugin.md) §4.3 — its imports and its parse errors: strings and ranges read out of the tree, never a `bodyNode`, `fullNode` or any other handle into WASM memory, since a node is valid only as long as its tree, which is freed when the file's pipeline run ends (lang-plugin §8.1). An answer that structured clone refuses — a function a plugin left in a Symbol's `source`, say — withdraws its file as a throw does (lang-plugin §7.2), with the code `extraction-uncloneable`: `extraction threw — its extraction holds a value that cannot leave the parser worker: <why>. Run with --concurrency 1 to extract every file on the main thread.` What the file's extraction said is still said, and where it cannot be cloned either — a log line a plugin wrote as something other than a string — the file is withdrawn without it. A log line whose metadata cannot be cloned loses the metadata and is still said.

Rule PF-8: a worker runs the per-file pipeline to its end — extraction, framework classification, the Symbol drop, the body walk, effect classification and the call drop, and the file's fingerprints ([cli-spec.md](./cli-spec.md) §5.3 step 4). What reads the whole workspace — LSP enrichment, call resolution ([call-resolution.md](./call-resolution.md)), effect propagation, the `logic` fingerprint again, the IR's integrity check — runs on the main thread once every file has been folded, because it needs the union of all symbols.

## 6. Backpressure and memory

### 6.1 Concurrency default

`max(1, ceil((processors - 1) / scansAtOnce))`, clamped by memory and by the size of the source (Rule PF-2).

### 6.2 Heap and stack per worker

A worker is spawned with no `maxOldGenerationSizeMb`. Its default heap limit is the main thread's, and the budget a plugin declares is not a figure for the JavaScript heap: a tree-sitter grammar's memory is a WebAssembly memory, outside the old generation such a cap limits. Capping each worker at its declared budget would bound nothing the budget measures and would end workers on files the main thread extracts, breaking Rule PF-11. The budget sizes the pool instead (Rule PF-2). A worker that does run out of memory ends as any other (§8), and the file it was extracting is withdrawn saying it `ran out of memory`.

A worker's stack is sized to the main thread's: V8's default of 984 KiB plus the 192 KiB Node keeps of a worker's stack for itself. That brings a worker to within 2% of the main thread's depth — measured, 12,523 frames deep on the main thread and 12,299 on a worker so sized, against 49,675 at a worker's default 4 MiB — and short of it, never past it: a file nested deeply enough to exhaust the main thread's stack exhausts a worker's too, and only one nested within those last 2% extracts on the main thread and fails on a worker (Rule PF-11). The thread `aburi diff` scans its base on ([cli-spec.md](./cli-spec.md) §14.1) is sized the same, so the base side of a diff nests as deep as its head at any `--concurrency`, within the same 2%.

### 6.3 Two files in flight per worker

The main thread keeps at most two files in flight on each worker: the one it is extracting, and the next, so that a worker has its next file before it answers for the one it has. The rest wait on the main thread as file indices. Answers that arrive ahead of an earlier file's are held until that file's has been folded (§7.2); what they hold — the files' Symbols and content — is what the scan keeps of every file it extracts once folded anyway, so running ahead raises peak memory by no more than the finished extraction holds.

### 6.4 Parser lifecycle

The rule from [lang-plugin.md](./lang-plugin.md) §8.1 stands, on both sides of it: `parseFile()` creates a fresh `Parser` and calls `parser.delete()` after obtaining the result, while the tree it hands over is freed by whoever ran the pipeline for that file, through the plugin's `releaseTree`. Node references drawn out of the tree live as long as the tree does — the file's pipeline run — and no longer. This document does NOT change that rule; the plugin API surface is unchanged by the worker pool.

Rule PF-9 (worker follows plugin lifecycle): each worker invokes the plugin's `parseFile()` per file, which owns the parser lifecycle end-to-end per [lang-plugin.md](./lang-plugin.md) §8.1. No parser handle is retained across `parseFile()` calls. Rationale: reusing a parser across files would require a new API surface between the worker runtime and the plugin (parser injection), which is a change to `lang-plugin.md` §4 out of scope for this document. Parser-construction cost is real (5–15 ms per file on the reference corpus) but sits within the 30 s budget with headroom given file count and per-file work.

Rule PF-9a (each worker brackets its own plugins): a worker initializes the plugins it loaded, in the order and with the context of [lang-plugin.md](./lang-plugin.md) §3, before it extracts its first file, and cleans them up, newest first, when the pool closes or retires it, once the file it is extracting is done; it begins no other. The pool closes at the end of the scan's extraction, whether it finished or a fault ended it, and waits for every worker it started, a replaced one among them, to have cleaned up and exited. A worker retired because an answer of its could not be read cleans up as it goes; one that exited cannot. What a worker's plugins log as they initialize or clean up crosses with `ready`, `failed` and `closed`, and the main thread says each distinct line once, however many workers log it, so the log is the single thread's (Rule PF-11). The plugin objects the scan itself loaded make no call while a pool extracts, and are not initialized.

Rule PF-10 (parser-reuse is a future optimization): a future refinement of `lang-plugin.md` MAY introduce a `capabilities.parserInjection: true` opt-in through which the worker runtime supplies a long-lived parser. When and if that lands, this document will be revised to specify the injection contract. Until then the per-file lifecycle above is the only supported shape.

## 7. Determinism / canonical merge

The byte-identical output invariant is the strongest correctness property this document specifies. It is what lets users trust the pool and what lets CI compare `aburi scan --concurrency 1` output to `--concurrency 4` output without a special diff mode.

### 7.1 Invariant

Rule PF-11 (byte-identical output): for any input, `aburi scan --concurrency 1` and `aburi scan --concurrency N` write the same bytes — the IR, the pages, the discovered-vocabulary record — for every `N`, print the same stdout, exit with the same code, and write the same stderr but for the debug line that names the pool (Rule PF-2). This holds regardless of file arrival order, worker scheduling, disk cache warmth, or GC timing, and for `aburi diff` and `aburi explain`, which run the same scan. The exceptions have no single-thread counterpart: a worker that ends under a file (§8), where one thread would have ended with the process, an extraction holding a value structured clone refuses (Rule PF-7), which one thread never has to send, and a file nested within the 2% of stack depth a worker falls short of the main thread by (§6.2), which fails on a worker as a stack overflow.

### 7.2 Merge algorithm

1. The main thread asks for every file's extraction, in file order, as extraction starts.
2. It folds the answers in file order: a file's is folded once every earlier file's has been, however they arrive. The fold is where a file's log is said, a skipped file recorded, a withdrawn one warned about, its Symbols accumulated and a run-ending fault thrown, and it is the fold the single-thread path uses (Rule PF-18), so what the rest of the scan reads is built in the same order from the same parts.
3. A file whose extraction ends the run — a strict scan's undeclared value, a fault of the plugin set, a file that cannot be read — ends it at that file, as one thread does. Later files may have been extracted, but none is folded, so nothing they would have said is said, and the pool is stopped.
4. From there the scan runs as one thread does (Rule PF-8): `symbols[]` sorted by `Symbol.id` lexicographically ([ir-schema.md](./ir-schema.md) §3), call resolution over the sorted array, `dependencies[]` sorted by `(from, to, via)`, and JSON serialized with a stable key order.

Rule PF-12: no step above depends on wall-clock time, PID, which worker extracted a file, or random values. Any implementation that reads any of these is a bug.

#### 7.2.1 What N workers say once

A worker reads what its files need by itself, so what one thread does once N workers may each do: each creates its own import resolver for each language ([lang-plugin.md](./lang-plugin.md) §4.8), and each reads a barrel's import edges when a file it extracts imports through that barrel. What that says is recorded under a key, and the fold says only the first event of each key in the scan, so the scan says it as often as one thread would:

- a barrel's edges read for an importer — the debug line saying the barrel gave none, and a tree whose release failed while reading them — once per barrel, and not at all once the barrel itself has been folded, since one thread reuses the edges of a file it has extracted instead of reading them again;
- an import resolver that could not be created — once per plugin;
- an import resolver that threw on a specifier — once per specifier and the file it is written in;
- a line an import resolver logged — once per plugin, level and text, as each worker's resolver reads the same configuration and says the same of it. One thread folds the same way, so a resolver that says one line twice is heard once on any number of threads.

Which resolver failure is a warning (the first per plugin) and which are debug lines, and the count of them at the end of the scan, are decided at the fold over the failures that survive the keys, so they count what one thread counts.

### 7.3 Forbidden non-determinism sources

The following are banned inside worker code and inside main-thread merge code:

- `Date.now()`, `performance.now()` values in output. The parse and classify budgets read the clock; what they decide — that a file ran out of time — is output, and the time itself is not.
- `Math.random()`.
- Which worker extracted a file, in any output, stderr included.
- Iteration order over `Map` / `Set` objects populated in arrival order rather than file order, unless subsequently sorted.

Rule PF-13: parity tests enforce these bans (PT2, PT9): the same workspace is scanned on one thread and on several pool sizes, and every byte of output compared. A lint rule cannot tell the timers the parse and classify budgets need from a timestamp in output, and a parity test catches what reaches output whatever its source.

## 8. Failure isolation

Rule PF-14: a worker that ends while extracting a file F — it exits (a plugin called `process.exit()`), throws outside the scan's own error handling (from a timer, say), or runs out of memory — costs F and nothing else, in this order:

1. The worker's `exit` event reaches the main thread after every answer the worker sent, and the main thread takes the first of the worker's files still in flight as F. An `error` the worker ended with comes first, and only says what ended it: it comes through a port of its own, which a busy main thread can read ahead of answers the worker sent before it threw, so taking F there could withdraw a file the worker had answered for. A worker whose answer the main thread cannot read (`messageerror`) is ended at once, with that answer's file as F, since nothing else would settle it.
2. F is withdrawn as a file whose extraction threw is ([lang-plugin.md](./lang-plugin.md) §7.2): `stats.skippedFiles` and `ScanResult.skipped` name it with reason `extraction-failed`, `ScanResult.extractionFailures` carries the reason with the code `extraction-thread-ended`, and the fold warns, in F's place among the other files' lines, `Skipped F: the parser worker extracting it <ended with exit code N; a plugin may have called process.exit() | threw outside the scan's own error handling: <the stack, or the value thrown> | ran out of memory: <message> | sent an answer that could not be read: <why>>. Run with --concurrency 1 to extract every file on the main thread.` `aburi scan` exits `3`, as it does for any withdrawn file.
3. The worker's other file goes back to the front of the queue, and the slot gets a new worker when it is next handed a file. No file already extracted is lost.

A worker that ends with no file in flight withdraws none, and still counts towards Rule PF-15.

Rule PF-15: the third worker to end in one scan, on any slot, ends the run with exit `1`, a runtime failure ([cli-spec.md](./cli-spec.md) §9): `Parser workers ended 3 times (extracting <F1>; extracting <F2>; between files), so the plugins, not one file, are ending them. Run with --concurrency 1 to extract every file on the main thread.` Rationale: a repeated end indicates a systemic issue — heap exhaustion under a common file shape, a plugin that exits — that will not resolve by continuing, and a new worker in a slot is just another worker, so counting per slot would let a pool of eight withdraw sixteen files before giving up.

Rule PF-15a: a plugin whose `init` fails on a worker ends the run as it would on one thread — exit `3`, `Plugin "<name>" failed to initialize: <reason>` ([lang-plugin.md](./lang-plugin.md) §3) — since every worker initializes the same plugins. Otherwise a worker that cannot load the scan's plugins, or ends before it has, ends the run with exit `1` — `A parser worker failed: <error>`, or `A parser worker <how it ended> before it had loaded the scan's plugins.` — naming `--concurrency 1`. No file is to blame, and every worker would fail the same way. So does a worker that cannot be started, at the pool's start or in place of one that ended — `A parser worker could not be started: <error>` — once the workers already started are ended, and a worker script that cannot be found, as when a bundle inlines `@aburi/cli` and leaves the script behind.

Rule PF-16: a withdrawn file is reported as any skipped file is — in `stats.skippedFiles` and on stderr — and the IR holds no Symbol for it; downstream (call resolution, effect propagation) sees a file with no Symbols, which is already a valid input.

## 9. Progress reporting integration

The progress line ([cli-spec.md](./cli-spec.md) §10.2) counts a file once its extraction has finished: on one thread as it is folded, on a pool as the worker answers for it, so one slow file does not hold the count back while the workers extract the files after it. A file a worker answers for after the scan has stopped (§7.2 step 3) is not counted. The line never reaches the log, so counting ahead of the fold leaves Rule PF-11 standing.

## 10. LSP enrichment interaction

LSP enrichment ([lsp-enrichment.md](./lsp-enrichment.md)) runs as a **separate phase** from parsing. The pipeline is:

```
enumerate → detect components → parse phase (worker pool)
                                     ↓
                               fold on main
                                     ↓
                              LSP enrichment (if enabled)
                                     ↓
                              call resolution
                                     ↓
                              effect propagation
                                     ↓
                                fingerprint
                                     ↓
                                serialize IR
```

Rule PF-17: no LSP call is made from inside a worker. LSP concurrency is bounded by `lsp.servers.<lang>.concurrency` ([lsp-enrichment.md](./lsp-enrichment.md) §5, default 8) — a separate axis from parse concurrency, so a project may parse at concurrency 4 while enriching at concurrency 8 without contention.

Rationale for the phase split:

- LSP servers are typically single-instance-per-workspace; multiplexing them across workers adds no throughput and increases queue contention on the LSP side.
- Parse output is a stable input for LSP enrichment; running them in the same phase would require a partial-parse state machine on the LSP side.
- Keeping enrichment on the main thread means enrichment can consult the union of all symbols (needed for `this`/`super` resolution across sibling files).

## 11. Fallback: single-thread mode

Rule PF-18: `--concurrency 1`, and a default that sizes the pool to one (Rule PF-2), start no worker. The scan extracts every file inline on the main thread, in file order, through the extractor a worker runs, and folds each answer as it comes. No worker spawn, no `postMessage`, no queue. This mode is the reference implementation for correctness debugging: any parity failure between `--concurrency 1` and `--concurrency N` output is a pool bug, not an extraction bug.

Rule PF-19: a worker runs the extractor the main thread runs — the same function, given the same job, holding plugins loaded the same way — and the main thread folds its answers with the fold it uses for its own. The envelope adds the structured clone of each answer (Rule PF-7), the worker ends of §8 and the keys of §7.2.1, and nothing else.

## 12. Native binding fallback

Reserved for the future via `capabilities.preferNative` in the language plugin manifest ([lang-plugin.md](./lang-plugin.md) §8.1). When a plugin declares native support and the runtime detects a compatible platform, that plugin's workers MAY use a native tree-sitter binding instead of the WASM one. The choice is per-plugin per-run; it does not change the worker pool's shape, serialization boundary, or determinism rules — only the parser instance behind each worker.

Rule PF-20: when a native binding is in use, `capabilities.wasmHeapPerWorkerMB` still bounds pool sizing (the memory rule, Rule PF-2), because pool sizing needs a conservative upper bound regardless of which parser variant is active.

## 13. Verifiable Properties

Rows are prefixed `PT` (performance test) to avoid collision with the rules above (`Rule PF-<n>`), so a citation of either names one property. A row that tests a numbered rule names it in the Expected column.

| ID | Input | Expected |
| --- | --- | --- |
| PT1 | Reference corpus (§2), `--concurrency 4`, cold cache, 4-core runner | Wall time ≤ 30 s; peak RSS ≤ 2 GiB. **Pending corpus PR** — verifiable once `benchmarks/perf-1k/` lands (§2). |
| PT2 | `aburi scan --concurrency N` for N ∈ {1, 2, 3, more than there are files}, over files that fail to parse, parse with recoverable errors, parse to no tree, throw in extraction, emit two Symbols under one id and emit an undeclared value; N ∈ {1, 3} over TypeScript with the NestJS framework and effects plugins; `aburi diff main..HEAD --concurrency N` for N ∈ {1, 2}, with its scans at once and in turn; `aburi explain` over the scan it runs, for N ∈ {1, 2} | The IR, the discovered-vocabulary record, the report, stdout, the exit code and stderr of `--concurrency 1`, but for the debug line naming the pool (Rule PF-11; this is the test Rule PF-13 requires). That line says each run above 1 extracted on N workers, the file count for more than there are files, at least 2 for TypeScript, and `shared by 2 scans` for each of the diff's scans at once |
| PT3 | A file whose extraction, on a worker, holds a function; a file whose outcome holds one, and whose events do or do not | That file withdrawn, `extraction threw — its extraction holds a value that cannot leave the parser worker: <why>. Run with --concurrency 1 …` on stderr and the code `extraction-uncloneable`, with what it said where that can be cloned and without it where it cannot; every other file extracted; exit 3. A log line's metadata a clone refuses left out, and the line kept (Rule PF-7) |
| PT4 | A worker exits, or throws an `Error` or `null` outside the scan's own handling, while extracting one file | That file withdrawn with `the parser worker extracting it` and what ended it on stderr, and `extraction-thread-ended` on its `ScanResult.extractionFailures` entry; every other file extracted; exit 3 (Rule PF-14) |
| PT4a | A worker that throws, on a later tick, under a file — the first it was handed, just after saying it had loaded the plugins, or the second, just after answering for the first — while the main thread is busy, so that its `error` is read ahead of what it sent before it | The file it threw under withdrawn, and the other extracted (Rule PF-14 step 1) |
| PT4b | A worker's answer the main thread cannot read | That file withdrawn, `sent an answer that could not be read: <why>`, and the rest extracted on a new worker (Rule PF-14 step 1) |
| PT4c | A worker that ends as out of memory, or with a value thrown that is not an `Error` | `ran out of memory: <message>`, or `threw outside the scan's own error handling: <the value>` (Rule PF-14 step 2) |
| PT5 | Workers end under three files, on two slots | exit 1, stderr naming the three files and `--concurrency 1` (Rule PF-15) |
| PT5a | A plugin that throws, or calls `process.exit()`, when loaded on a worker | exit 1, `A parser worker failed: <error>`, or `A parser worker ended with exit code N; … before it had loaded the scan's plugins.`, and `--concurrency 1` on stderr (Rule PF-15a) |
| PT5b | A worker that cannot be started as the pool starts, or in place of one that ended; no worker script to start | Every file not yet extracted refused with `A parser worker could not be started: <error>` and `--concurrency 1`, and the workers already started ended; the pool refused before it starts a worker, naming `--concurrency 1` (Rule PF-15a) |
| PT5c | A plugin that logs from `init` and whose `cleanup` throws, and one whose `init` throws, at `--concurrency 1` and `2` | The same stderr and exit code: the line and the warning said once, or exit 3 with `Plugin "<name>" failed to initialize` (Rules PF-9a, PF-15a) |
| PT5d | A pool of two workers, and a pool of one whose worker is retired for an answer it could not read | Each worker that extracted a file initialized its plugins before its first and cleaned them up as the pool closed, the retired one among them (Rule PF-9a) |
| PT6 | The core's extraction run on one extractor per file, on two taking turns, and on three taking runs of two, each holding plugins of its own, over barrels read before and after they are extracted and an import resolver that warns once per instance and throws on some specifiers, one of them written in two files; and over a resolver that no extractor can create | The IR and every log line of the same scan on one extractor: the resolver's warning once, its first failure a warning, a failure for each file the failing specifier is written in, and the rest counted at the end; the failure to create the resolver once; and the trees that failed to release as one extractor reports them (Rule PF-19, §7.2.1) |
| PT7 | Pool size clamped by available memory | `--concurrency 8` with 512 MiB a worker: 8 workers on 4 GiB available, 4 on 2 GiB; with 256 MiB a worker, 3 on 1000 MiB and the main thread on 100 MiB; half the memory each when two scans run at once (Rule PF-2) |
| PT7a | Default pool size | One fewer than the processors; the main thread on one processor or under 256 KiB of source; one worker for each 256 KiB below that; half the spare processors each when two scans run at once. `--concurrency` holds however little the source; both are capped at the file count (Rule PF-2) |
| PT8 | A worker ends under one file with its next file already handed to it | That next file is extracted by another worker, and the IR holds it (Rule PF-14 step 3) |
| PT9 | A strict scan at `--concurrency 3` whose undeclared value sits in a file with later files after it; in the core, a pool on which the file after the fault finishes first | Stops at that file, with the exit code and stderr of `--concurrency 1`, and nothing of the later files said (§7.2 step 3) |
| PT11 | LSP enabled | Parse phase completes fully before LSP phase starts; no worker calls LSP (§10; Rule PF-17) |
| PT12 | Two lang plugins declare `wasmHeapPerWorkerMB` = 256 and 512, or 64 and none | Pool sizing uses 512, or the default 256 (Rule PF-2) |
| PT13 | A node handle outlives the tree it came from — the plugin kept one past `parseFile()`, or the worker kept one past the file's pipeline run (a bug, not a runtime failure) | Plugin conformance tests SHOULD detect this via lang-plugin's own test harness (see [lang-plugin.md](./lang-plugin.md) §9); the pool itself makes no additional check. Listed here for completeness — this is an invariant of the plugin contract. |
| PT14 | A pool on which a file finishes ahead of the files before it; a pool on which a file finishes after the scan has stopped | The progress count takes the file as it finishes, and takes none after the scan has stopped (§9) |
| PT15 | The core's extraction on a pool whose extraction rejects | The scan rejects with that error, and the pool is closed |
| PT15a | A worker asked for a file its extractor rejects, between two it extracts | That file rejects with the extractor's own error, and the worker extracts the next (§5.2) |

## 14. Design Decisions

### 14.1 Why `worker_threads` over `child_process`

Structured-clone `postMessage` is faster than piped stdout for the ~50 KB `SymbolCandidate[]` payload per file, and it exposes `Transferable` if a future optimization needs zero-copy passing of `ArrayBuffer`. `child_process` also incurs a Node startup penalty per worker (~40 ms) that `worker_threads` avoids. The base scan of `aburi diff` already ran on a worker thread ([cli-spec.md](./cli-spec.md) §14.1), so the pool adds no runtime requirement.

### 14.2 Why file-level shards instead of component-level

Component sizes skew heavily in real monorepos. A component-level shard leaves N-1 workers idle for the tail of the largest component. File-level shards give each worker a stream of similarly-sized work units, and the fold in file order (§7.2) preserves byte-identical output whichever worker extracts which file.

### 14.3 Why parser reuse is deferred, not adopted here

An earlier draft of this document adopted parser reuse across files inside one worker (parser constructed once at worker startup, `parser.delete()` at shutdown) as an optimization. On review the trade-off was inverted: parser reuse requires a new API surface between the worker runtime and the plugin (parser injection), which would silently change [lang-plugin.md](./lang-plugin.md) §8.1's per-file lifecycle rule. Two design docs disagreeing about `Parser`'s lifetime is a worse outcome than 5–15 ms per file of construction cost. If the parse budget later proves tight, the fix is a `lang-plugin.md` refinement (`capabilities.parserInjection` opt-in), not a silent override in `performance.md`.

### 14.4 Why single-thread mode remains the reference implementation

Byte-identical determinism is only useful if the check has a definite ground truth. `--concurrency 1` is that ground truth. It also gives users a debugging escape hatch: any behavior only reproducible under the pool is by definition a pool bug, and it can be reproduced by rerunning under `--concurrency 1` and diffing. Every error the pool raises names it.

### 14.5 Why LSP is a separate phase

LSP servers are typically single-instance-per-workspace and stateful. Multiplexing them from N parse workers would add queue-contention on the LSP side without adding throughput. Running enrichment after parse also means the enricher sees the complete symbol universe, which it needs for cross-file `this`/`super` resolution.

### 14.6 Why two in flight, and every file asked for at once

With one file in flight a worker idles for a round trip after each file, waiting for the main thread to fold its answer and hand it the next. A third buys nothing, as a worker extracts one file at a time. The main thread asks for every file at once so that a worker can run ahead of a slow file rather than idle until it is folded; what it holds ahead is what the scan keeps anyway (§6.3), while the files still waiting are indices.

### 14.7 Why the next free worker, not a hash of the path

An earlier draft assigned each file to `stable_hash(path) mod pool_size`, for determinism at assignment. It bought none that reached output, which the fold in file order already makes independent of assignment (§7.2), and it cost load balance: a worker's share followed the hash rather than the files' cost, so the worker that drew the slow files finished last while the others idled. A barrel parsed on one worker or another is the one place where assignment could have shown, and the keys of §7.2.1 make what it says independent of which worker read it.

### 14.8 Why the default counts source bytes

A worker is not free. Starting one loads every plugin again, grammars included — about 300 ms measured — and a file costs about 1.4× on a worker what it costs inline, the difference being the round trip and the clone of its answer. Measured on Aburi's own repository (878 files) on four processors: 6.0 s on one thread, 4.4 s on two workers, 3.9 s on three and 3.8 s on four; on `packages/core` alone (184 files, 875 KiB): 2.2 s on one thread, 1.8 s on two and 1.9 s on three. Below about 256 KiB of source for each worker, a worker costs more than the extraction it takes off the others, and the default starts none for it. An explicit `--concurrency` is honoured however little the source, since it is the caller's own measurement of their machine.
