import { rename } from "node:fs/promises"
import { resolve } from "node:path"
import {
  commitAll,
  git,
  initRepository,
  recordingLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff } from "../src"
import { collectRenames, parseRenameRecords } from "../src/git/renames"
import { defaultGitRunner } from "../src/git/runner"
import { fakeGit, gitOutput } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("git-renames")

function renames(stdout: string): ReadonlyMap<string, string> | null {
  const parsed = parseRenameRecords(stdout)
  return parsed.ok ? parsed.renames : null
}

describe("parseRenameRecords — `git diff --name-status -z` records", () => {
  it.each([
    ["a plain rename", "R094\0src/a.ts\0src/b.ts\0", [["src/a.ts", "src/b.ts"]]],
    ["a path containing a space", "R094\0src/a.ts\0src/a b.ts\0", [["src/a.ts", "src/a b.ts"]]],
    [
      "paths containing a tab",
      "R094\0src/a\tb.ts\0src/c\td.ts\0",
      [["src/a\tb.ts", "src/c\td.ts"]],
    ],
    [
      "non-ASCII paths, unquoted",
      "R100\0src/日本語.ts\0src/請求 書.ts\0",
      [["src/日本語.ts", "src/請求 書.ts"]],
    ],
    ["a diff that changed nothing", "", []],
    ["records that are not renames", "M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0", []],
    [
      "a copy's second path, so the records after it stay aligned",
      "C085\0src/a.ts\0src/b.ts\0R097\0src/c.ts\0src/d.ts\0",
      [["src/c.ts", "src/d.ts"]],
    ],
    [
      "renames among other statuses",
      "M\0src/keep.ts\0R061\0src/old name.ts\0src/new name.ts\0A\0src/added.ts\0",
      [["src/old name.ts", "src/new name.ts"]],
    ],
  ])("reads %s", (_, stdout, pairs) => {
    expect(renames(stdout)).toEqual(new Map(pairs as [string, string][]))
  })

  it("normalizes both paths to NFC, the form source.file is compared in", () => {
    const decomposed = "src/請求.ts".normalize("NFD")
    const composed = "src/請求.ts".normalize("NFC")
    expect(renames(`R100\0${decomposed}\0${decomposed}2\0`)).toEqual(
      new Map([[composed, `${composed}2`]]),
    )
  })

  it.each([
    ["a rename cut after its first path", "R094\0src/a.ts\0", 0, "R094"],
    ["a stream cut mid-field", "R094\0src/a.ts\0src/b.t", 2, "src/b.t"],
    ["a path where a status belongs", "src/a.ts\0src/b.ts\0", 0, "src/a.ts"],
  ])("refuses %s, saying where it stopped reading", (_, stdout, index, field) => {
    expect(parseRenameRecords(stdout)).toEqual({ ok: false, index, field })
  })

  it("reads what a real git writes for renamed paths with spaces and non-ASCII characters", async () => {
    const root = workspace.root
    await initRepository(root)
    await git(["config", "core.quotePath", "true"], root)
    await writeFileAt(root, "src/a.ts", "export const spaced = 1\n")
    await writeFileAt(root, "src/plain.ts", "export const nonAscii = 2\n")
    await writeFileAt(root, "src/kept.ts", "export const kept = 3\n")
    await commitAll(root, "base")
    await git(["mv", "src/a.ts", "src/a b.ts"], root)
    await git(["mv", "src/plain.ts", "src/日本語 ファイル.ts"], root)
    await writeFileAt(root, "src/kept.ts", "export const kept = 4\n")
    await writeFileAt(root, "src/new.ts", "export const fresh = 1\n")
    await commitAll(root, "head")

    const stdout = await git(
      ["diff", "--find-renames", "--name-status", "-z", "HEAD~1..HEAD"],
      root,
    )

    expect(renames(stdout)).toEqual(
      new Map([
        ["src/a.ts", "src/a b.ts".normalize("NFC")],
        ["src/plain.ts", "src/日本語 ファイル.ts".normalize("NFC")],
      ]),
    )
  })
})

describe("collectRenames — when git gives no usable hints", () => {
  const SPEC = { base: "main", head: "HEAD" }

  function answering(result: () => { stdout: string; stderr: string }): GitRunner {
    return { run: async () => result() }
  }

  it.each<[string, GitRunner, string[]]>([
    [
      "git fails",
      answering(() => {
        throw new Error("no such ref pair")
      }),
      ["Failed to collect git renames (no such ref pair)", "removed + added"],
    ],
    [
      "the record stream is unreadable",
      answering(() => ({ stdout: "R094\0src/a.ts\0", stderr: "" })),
      ["main..HEAD produced a record this parser could not read", '(field 0: "R094")'],
    ],
  ])("drops the hints and warns when %s", async (_, runner, fragments) => {
    const log = recordingLogger()

    expect(await collectRenames(runner, workspace.root, SPEC, log.warn)).toBeNull()

    expect(log.warnings).toHaveLength(1)
    for (const fragment of fragments) expect(log.warnings[0]).toContain(fragment)
  })

  it("passes on whatever git says over a range, line by line as it said it", async () => {
    const log = recordingLogger()
    const runner = answering(() => ({
      stdout: "",
      stderr:
        "warning: refname 'main' is ambiguous.\nwarning: in the working copy of 'a.ts', LF will be replaced by CRLF the next time Git touches it\n",
    }))

    expect(await collectRenames(runner, workspace.root, SPEC, log.warn)).toEqual(new Map())

    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]).toContain(
      "for main..HEAD: warning: refname 'main' is ambiguous.\nwarning: in the working copy of 'a.ts'",
    )
  })

  it("keeps what it read but warns when git exits 0 having given up on rename detection", async () => {
    const log = recordingLogger()
    const runner = answering(() => ({
      stdout: "D\0src/a.ts\0A\0src/b.ts\0",
      stderr: "warning: exhaustive rename detection was skipped due to too many files.\n",
    }))

    expect(await collectRenames(runner, workspace.root, SPEC, log.warn)).toEqual(new Map())

    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]).toContain("exhaustive rename detection was skipped")
    expect(log.warnings[0]).toContain("diff.renameLimit")
  })
})

describe("collectRenames — what git says while reading the working tree", () => {
  const RENAME_LIMIT =
    "warning: exhaustive rename detection was skipped due to too many files.\nwarning: you may want to set your diff.renameLimit variable to at least 3 and retry the command.\n"

  it.each<[string, { diff?: string; add?: string }, string[]]>([
    [
      "the two-line line-ending note git wrote before 2.37",
      {
        diff: "warning: LF will be replaced by CRLF in src/rename.ts.\nThe file will have its original line endings in your working directory\n",
      },
      [],
    ],
    [
      "a rename limit beside a line-ending note",
      {
        diff: `warning: in the working copy of 'src/a.ts', LF will be replaced by CRLF the next time Git touches it\n${RENAME_LIMIT}`,
      },
      [
        "git reported while collecting renames for main against the working tree: warning: exhaustive rename detection was skipped due to too many files. warning: you may want to set your diff.renameLimit",
      ],
    ],
    [
      "a directory the add could not read",
      { add: "warning: could not open directory 'secret/': Permission denied\n" },
      [
        "Rename detection for main against the working tree may be missing files git does not track: warning: could not open directory 'secret/': Permission denied. A move of one without `git mv` is reported as removed + added",
      ],
    ],
  ])("passes on all but the line-ending notes, given %s", async (_, stderr, fragments) => {
    const { runner } = fakeGit({
      handlers: {
        "diff --find-renames": () => gitOutput("", stderr.diff),
        "add --intent-to-add": () => gitOutput("", stderr.add),
      },
    })
    const log = recordingLogger()
    const span = { base: "main", scratchIndex: resolve(workspace.root, "index") }

    expect(await collectRenames(runner, workspace.root, span, log.warn)).toEqual(new Map())

    expect(log.warnings).toHaveLength(fragments.length)
    fragments.forEach((fragment, at) => {
      expect(log.warnings[at]).toContain(fragment)
    })
    expect(log.warnings.join("\n")).not.toContain("line endings")
    expect(log.warnings.join("\n")).not.toContain("working copy")
  })
})

describe("aburi diff — a file renamed between the revisions", () => {
  it("reports its Symbol as moved, whatever characters the path holds", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(
      root,
      "src/請求 書.ts",
      "export function invoice(): number {\n  return 1\n}\n",
    )
    await commitAll(root, "base")
    await git(["mv", "src/請求 書.ts", "src/請求 済.ts"], root)
    await commitAll(root, "head")
    const log = recordingLogger()

    const report = await runDiff({
      cwd: root,
      refSpec: "HEAD~1..HEAD",
      outputDir: resolve(root, "out"),
      failOn: "added,removed",
      warn: log.warn,
    })

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔1 ⤴0")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toEqual([])
  })

  it.each<[string, (root: string) => Promise<string>]>([
    [
      "with `git mv` and not committed",
      async (root) => {
        await git(["mv", "src/a.ts", "src/b.ts"], root)
        return "HEAD..HEAD"
      },
    ],
    [
      "without git being told",
      async (root) => {
        await rename(resolve(root, "src/a.ts"), resolve(root, "src/b.ts"))
        return "HEAD..HEAD"
      },
    ],
    [
      "in a head revision that is not checked out",
      async (root) => {
        await git(["mv", "src/a.ts", "src/b.ts"], root)
        await commitAll(root, "head")
        await git(["checkout", "-q", "HEAD~1"], root)
        return "HEAD..main"
      },
    ],
  ])("pairs every Symbol of a file moved %s, leaving the index as it was", async (_, move) => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(
      root,
      "src/a.ts",
      "export function alpha(x: number) {\n  return x + 1\n}\nexport function beta(y: string) {\n  return y.trim()\n}\n",
    )
    await commitAll(root, "base")
    const refSpec = await move(root)
    const index = await git(["ls-files", "-z", "--stage"], root)
    const log = recordingLogger()

    const report = await runDiff({
      cwd: root,
      refSpec,
      outputDir: resolve(root, "out"),
      failOn: "removed",
      warn: log.warn,
    })

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔2 ⤴0")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toEqual([])
    expect(await git(["ls-files", "-z", "--stage"], root)).toBe(index)
  })

  it("keeps the rest of the map, and names the path, when git cannot add an untracked one", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(root, "src/a.ts", "export function alpha(x: number) {\n  return x + 1\n}\n")
    await writeFileAt(
      root,
      "src/c.ts",
      "export function gamma(y: string) {\n  return y.trim()\n}\n",
    )
    await commitAll(root, "base")
    await git(["mv", "src/a.ts", "src/b.ts"], root)
    await rename(resolve(root, "src/c.ts"), resolve(root, "src/d.ts"))
    // A name git keeps for its own directory, which it refuses to stage on every platform.
    await writeFileAt(root, "notes/git~1", "not a source\n")
    const index = await git(["ls-files", "-z", "--stage"], root)
    const log = recordingLogger()

    const report = await runDiff({
      cwd: root,
      refSpec: "HEAD..HEAD",
      outputDir: resolve(root, "out"),
      failOn: "removed",
      warn: log.warn,
    })

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔2 ⤴0")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]).toContain(
      "Rename detection for HEAD against the working tree may be missing files git does not track: ",
    )
    expect(log.warnings[0]).toContain("invalid path 'notes/git~1'")
    expect(await git(["ls-files", "-z", "--stage"], root)).toBe(index)
  })

  it("leaves the caller's index alone when the GitRunner does not apply `env`, and says so", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(root, "src/a.ts", "export function alpha(x: number) {\n  return x + 1\n}\n")
    await commitAll(root, "base")
    await rename(resolve(root, "src/a.ts"), resolve(root, "src/b.ts"))
    const index = await git(["ls-files", "-z", "--stage"], root)
    const withoutEnv: GitRunner = {
      run: (args, options) =>
        defaultGitRunner.run(args, options?.cwd === undefined ? {} : { cwd: options.cwd }),
    }
    const log = recordingLogger()

    await runDiff({
      cwd: root,
      refSpec: "HEAD..HEAD",
      outputDir: resolve(root, "out"),
      git: withoutEnv,
      warn: log.warn,
    })

    expect(log.warnings).toEqual([
      expect.stringContaining(
        "may be missing files git does not track: the GitRunner did not apply GIT_INDEX_FILE from `options.env`",
      ),
    ])
    expect(await git(["ls-files", "-z", "--stage"], root)).toBe(index)
  })

  it("says nothing of the line endings git notes while it reads the working tree", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(root, "src/a.ts", "export const a = 1\n")
    await writeFileAt(root, "src/rename-user.ts", "export const r = 1\n")
    await commitAll(root, "base")
    await git(["config", "core.autocrlf", "true"], root)
    await writeFileAt(root, "src/a.ts", "export const a = 2\n")
    await writeFileAt(root, "src/rename-user.ts", "export const r = 2\n")
    const log = recordingLogger()

    await runDiff({
      cwd: root,
      refSpec: "HEAD..HEAD",
      outputDir: resolve(root, "out"),
      warn: log.warn,
    })

    expect(log.warnings).toEqual([])
  })

  it("passes git's rename-limit warning to the caller's warn", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    for (const name of ["a", "b", "c"]) {
      await writeFileAt(root, `src/${name}.ts`, `export const ${name} = 1\n// one\n// two\n`)
    }
    await commitAll(root, "base")
    for (const name of ["a", "b", "c"]) {
      await git(["mv", `src/${name}.ts`, `src/${name}2.ts`], root)
      await writeFileAt(root, `src/${name}2.ts`, `export const ${name} = 1\n// one\n// three\n`)
    }
    await commitAll(root, "head")
    await git(["config", "diff.renameLimit", "1"], root)
    const log = recordingLogger()

    await runDiff({
      cwd: root,
      refSpec: "HEAD~1..HEAD",
      outputDir: resolve(root, "out"),
      warn: log.warn,
    })

    expect(log.warnings).toContainEqual(
      expect.stringMatching(
        /git reported while collecting renames for HEAD~1 against the working tree: .*rename detection was skipped/,
      ),
    )
  })
})
