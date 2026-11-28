import { spawnSync } from "node:child_process"
import { existsSync, rmSync, writeSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { availableParallelism, tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import type { ScanProgress } from "@aburi/core"
import type { GitRenameMap } from "@aburi/diff"
import type { IR } from "@aburi/types"
import type { PinnedConfig } from "../config-load"
import type { LogLevel } from "../env"
import { CliError, errorMessage, internalFault } from "../errors"
import { listIndex } from "../git/index-listing"
import { assertNotShallow, assertNotSparse, assertRefResolvable } from "../git/preflight"
import { collectRenames } from "../git/renames"
import { defaultGitRunner, type GitRunner, gitChildEnv } from "../git/runner"
import { submoduleIgnorePatterns } from "../git/submodules"
import { describeLinksReadAsSource, linksReadAsSource, plainFileLinks } from "../git/symlinks"
import { readIR } from "../ir-io"
import type { LogWrite } from "../logger"
import { cleanUpOnFatalSignal } from "../signal-cleanup"
import type { WarnFn } from "../warn"
import { resolveWorkspaceRoot } from "../workspace-root"
import type { RefSpec } from "./diff-inputs"
import { runScan } from "./scan"
import { reportScanIncidents } from "./scan-incidents"
import type { ScanReport } from "./scan-report"
import { type PortableScanOptions, scanInThread, type ThreadedScan } from "./scan-thread"

export type DiffSide = "base" | "head"

export const SIDES: readonly DiffSide[] = ["base", "head"]

/** What `runDiff` is doing: a scan of one side, the end of that scan, or the comparison. */
export type DiffProgress =
  | { readonly kind: "scan"; readonly side: DiffSide; readonly progress: ScanProgress }
  | { readonly kind: "scanned"; readonly side: DiffSide }
  | { readonly kind: "comparing" }

export type ScanPair = Record<DiffSide, ScanReport>

export interface ScannedRevisions {
  baseIR: IR
  headIR: IR
  gitRenames: GitRenameMap | null
  scans: ScanPair
}

export interface RevisionScanContext {
  cwd: string
  git: GitRunner | undefined
  compact: boolean | undefined
  logLevel: LogLevel | undefined
  pinConfigOnce: () => Promise<PinnedConfig>
  warn: WarnFn
  log: LogWrite
  progress: ((progress: DiffProgress) => void) | undefined
  parallelScans: boolean | undefined
  concurrency: number | undefined
}

/** A side's revision, checked out in a worktree of its own at `dir`. */
interface Checkout {
  dir: string
  ref: string
}

export async function scanRevisions(
  spec: RefSpec,
  context: RevisionScanContext,
): Promise<ScannedRevisions> {
  const { cwd, warn } = context
  const git = context.git ?? defaultGitRunner
  await assertRefResolvable(git, cwd, spec.base, "base")
  const headCommit = await assertRefResolvable(git, cwd, spec.head, "head")
  await assertNotShallow(git, cwd)
  await assertNotSparse(git, cwd)

  const headIsWorkingTree = headCommit === (await checkedOutCommit(git, cwd))
  const pinnedConfig = await context.pinConfigOnce()
  const headWorkspaceRoot = await resolveWorkspaceRoot(cwd)
  // Read before either worktree exists, as every other check is, unless the head has an index
  // only once it is checked out.
  const workingTreeListing = headIsWorkingTree ? await listHead(git, headWorkspaceRoot, warn) : null
  const tempParent = await mkdtemp(resolve(tmpdir(), "aburi-worktree-"))
  // Each side's checkout under a level of its own, so the leaf is free to be any name the workspace has.
  const checkoutOf = (side: DiffSide, ref: string): Checkout => ({
    dir: resolve(tempParent, side, checkoutLeaf(headWorkspaceRoot)),
    ref,
  })
  const checkouts: Record<DiffSide, Checkout | null> = {
    base: checkoutOf("base", spec.base),
    head: headIsWorkingTree ? null : checkoutOf("head", spec.head),
  }
  const labels: Record<DiffSide, string> = {
    base: labelFor("base", spec.base),
    head: labelFor("head", headIsWorkingTree ? null : spec.head),
  }
  const planned = SIDES.flatMap((side) => checkouts[side] ?? [])
  const added: string[] = []

  const said = new Set<string>()
  const together = context.parallelScans ?? availableParallelism() >= 2
  const plainLinks: Record<DiffSide, string[]> = { base: [], head: [] }
  const sayPlainFileLinks = (side: DiffSide, ir: IR): IR => {
    const read = linksReadAsSource(plainLinks[side], ir)
    if (read.length > 0) {
      const checkedOut = checkouts[side] === null ? "working-tree" : "fresh-checkout"
      warn(`⚠ ${labels[side]}: ${describeLinksReadAsSource(checkedOut, read)}`)
    }
    return ir
  }
  const readerOf =
    (side: DiffSide) =>
    async (report: ScanReport): Promise<IR> => {
      const label = labels[side]
      reportScanIncidents(report, warn, label, said)
      const checkout = checkouts[side]
      if (checkout !== null && report.workspaceRoot !== checkout.dir) {
        throw internalFault(
          ` while scanning ${label}`,
          `the scan rooted at ${report.workspaceRoot} instead of the worktree ${checkout.dir}, so the two sides would describe different trees`,
          null,
        )
      }
      if (report.irPath === null) {
        throw new CliError(`Scan for ${label} produced no IR file.`, "runtime-error")
      }
      return sayPlainFileLinks(side, await readIR(report.irPath))
    }

  const releaseSignals = cleanUpOnFatalSignal(() => {
    for (const { dir } of planned) removeCheckoutSynchronously(cwd, dir)
    removeTemporaryDirectorySynchronously(tempParent)
  })
  try {
    const gitRenames = await collectRenames(
      git,
      cwd,
      headIsWorkingTree
        ? { base: spec.base, scratchIndex: resolve(tempParent, "index") }
        : { base: spec.base, head: spec.head },
      warn,
    )
    for (const { dir, ref } of planned) {
      await mkdir(dirname(dir), { recursive: true })
      await git.run(["worktree", "add", "--detach", dir, ref], { cwd })
      added.push(dir)
    }
    const rootOf = (side: DiffSide): string => checkouts[side]?.dir ?? headWorkspaceRoot
    const { submoduleIgnore, links } =
      workingTreeListing ?? (await listHead(git, rootOf("head"), warn))
    plainLinks.head = links
    plainLinks.base = await plainFileLinks(await listIndex(git, rootOf("base")), rootOf("base"))

    const sideScan = (side: DiffSide): SideScan => {
      const checkout = checkouts[side]
      return {
        options: {
          cwd: checkout?.dir ?? cwd,
          command: "diff",
          outputDir: resolve(tempParent, `${side}-out`),
          format: "json",
          pinnedConfig,
          pluginRefRoot: headWorkspaceRoot,
          // A worktree is made without dependencies, so the working tree's installed ones stand in for them.
          ...(checkout === null ? {} : { installedRoot: headWorkspaceRoot }),
          ...(submoduleIgnore.length === 0 ? {} : { ignore: submoduleIgnore }),
          ...(context.compact === undefined ? {} : { compact: context.compact }),
          ...(context.logLevel === undefined ? {} : { logLevel: context.logLevel }),
          ...(context.concurrency === undefined ? {} : { concurrency: context.concurrency }),
          scansAtOnce: together ? 2 : 1,
        },
        read: readerOf(side),
        ...reportOf(side, context.progress),
      }
    }
    const base = sideScan("base")
    const head = sideScan("head")
    const scanned = together
      ? await scanTogether(base, head, context.log, {
          name: labels.base,
          log: context.log,
          warn,
        })
      : await scanInTurn(base, head, context.log)
    return { ...scanned, gitRenames }
  } finally {
    // Failures here only warn: a throw from `finally` would replace the error that ended the scan.
    for (const checkout of added) {
      try {
        await git.run(["worktree", "remove", "--force", checkout], { cwd })
      } catch (error) {
        warn(
          `⚠ git worktree cleanup failed for "${checkout}"; ${errorMessage(error)}. Consider running \`git worktree prune\`.`,
        )
      }
    }
    try {
      await rm(tempParent, { recursive: true, force: true })
    } catch (error) {
      warn(
        `⚠ Failed to remove the temporary directory "${tempParent}"; ${errorMessage(error)}. It can be deleted by hand.`,
      )
    }
    releaseSignals()
  }
}

/** The commit the working tree at `cwd` stands for, when it has one. */
async function checkedOutCommit(git: GitRunner, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd })
    return stdout.trim()
  } catch {
    // A branch with no commit yet, checked out while the refs compared are elsewhere.
    return null
  }
}

/** What the head's index says the scans must know: its submodules, and its links git wrote as files. */
interface HeadListing {
  submoduleIgnore: string[]
  links: string[]
}

async function listHead(git: GitRunner, root: string, warn: WarnFn): Promise<HeadListing> {
  const index = await listIndex(git, root)
  return {
    submoduleIgnore: submoduleIgnorePatterns(index, warn),
    links: await plainFileLinks(index, root),
  }
}

interface SideScan {
  options: PortableScanOptions
  read: (report: ScanReport) => Promise<IR>
  report?: SideReport
}

interface SideReport {
  progress: (progress: ScanProgress) => void
  /** Called once the side's scan has returned, whatever it returned. */
  scanned: () => void
}

type ScannedSides = Omit<ScannedRevisions, "gitRenames">

function reportOf(
  side: DiffSide,
  report: ((progress: DiffProgress) => void) | undefined,
): Pick<SideScan, "report"> {
  if (report === undefined) return {}
  return {
    report: {
      progress: (progress) => report({ kind: "scan", side, progress }),
      scanned: () => report({ kind: "scanned", side }),
    },
  }
}

/** `runScan` for one side on this thread, its end reported however it ended. */
async function scanHere(side: SideScan, log: LogWrite, signal?: AbortSignal): Promise<ScanReport> {
  try {
    return await runScan({
      ...side.options,
      log,
      ...(side.report === undefined ? {} : { progress: side.report.progress }),
      ...(signal === undefined ? {} : { signal }),
    })
  } finally {
    side.report?.scanned()
  }
}

async function scanInTurn(base: SideScan, head: SideScan, log: LogWrite): Promise<ScannedSides> {
  const baseScan = await scanHere(base, log)
  const baseIR = await base.read(baseScan)
  const headScan = await scanHere(head, log)
  const headIR = await head.read(headScan)
  return { baseIR, headIR, scans: { base: baseScan, head: headScan } }
}

/**
 * The base on a thread of its own while the head runs here. What the run says, and which failure
 * ends it, is what `scanInTurn` would have: the head's log is held until the base is through, and
 * a base that fails stops the head and discards it, as the head would never have started. The head
 * still writes under the run's temporary directory until it stops, so the cleanup waits for it.
 */
async function scanTogether(
  base: SideScan,
  head: SideScan,
  log: LogWrite,
  baseThread: Omit<ThreadedScan, "progress">,
): Promise<ScannedSides> {
  const headLog = heldLog(log)
  const stopHead = new AbortController()
  const headScan = scanHere(head, headLog.write, stopHead.signal)
  const headStopped = headScan.then(
    () => undefined,
    () => undefined,
  )
  let baseScan: ScanReport
  let baseIR: IR
  try {
    try {
      baseScan = await scanInThread(base.options, {
        ...baseThread,
        ...(base.report === undefined ? {} : { progress: base.report.progress }),
      })
    } finally {
      base.report?.scanned()
    }
    baseIR = await base.read(baseScan)
  } catch (error) {
    stopHead.abort()
    await headStopped
    throw error
  }
  headLog.release()
  const headReport = await headScan
  const headIR = await head.read(headReport)
  return { baseIR, headIR, scans: { base: baseScan, head: headReport } }
}

function heldLog(log: LogWrite): { write: LogWrite; release: () => void } {
  let held: Parameters<LogWrite>[] | null = []
  return {
    write: (line, level) => {
      if (held === null) log(line, level)
      else held.push([line, level])
    },
    release: () => {
      for (const [line, level] of held ?? []) log(line, level)
      held = null
    },
  }
}

function removeCheckoutSynchronously(cwd: string, worktreeDir: string): void {
  // Read first, so a checkout the `finally` already removed is not reported as a failed remove.
  const hadCheckout = existsSync(worktreeDir)
  const removal = spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
    cwd,
    env: gitChildEnv(),
    stdio: "ignore",
  })
  if (hadCheckout && (removal.error !== undefined || removal.status !== 0)) {
    const why = removal.error?.message ?? `git exited ${removal.status ?? removal.signal}`
    // No `git worktree prune`: it would also remove prunable worktrees other people or tools made.
    reportFromSignal(
      `⚠ git worktree cleanup failed for "${worktreeDir}"; ${why}. Consider running \`git worktree prune\`.`,
    )
  }
}

function removeTemporaryDirectorySynchronously(tempParent: string): void {
  try {
    rmSync(tempParent, { recursive: true, force: true })
  } catch (error) {
    reportFromSignal(
      `⚠ Failed to remove the temporary directory "${tempParent}"; ${errorMessage(error)}. It can be deleted by hand.`,
    )
  }
}

function reportFromSignal(message: string): void {
  // Not `warn`: its asynchronous write to a pipe is not flushed before the signal is re-raised.
  try {
    writeSync(2, `${message}\n`)
  } catch {
    // stderr may have gone with the terminal (SIGHUP); a throw would skip the rest of the cleanup.
  }
}

function checkoutLeaf(headWorkspaceRoot: string): string {
  const leaf = basename(headWorkspaceRoot)
  return leaf.length === 0 || leaf === "@" ? "base" : leaf
}

function labelFor(side: DiffSide, ref: string | null): string {
  return ref === null ? "head (working tree)" : `${side} ref "${ref}"`
}
