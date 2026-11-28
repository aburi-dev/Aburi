import { copyFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { GitRenameMap } from "@aburi/diff"
import { errorCode, errorMessage } from "../errors"
import type { WarnFn } from "../warn"
import type { GitRunner } from "./runner"

/** The two trees a rename map pairs paths between: two revisions, or a revision and the working tree. */
export type RenameSpan =
  | { readonly base: string; readonly head: string }
  | {
      readonly base: string
      /**
       * Where a copy of the caller's index is written, so the untracked files of the working tree
       * can be added to it and a file moved without `git mv` still pairs with its old path.
       */
      readonly scratchIndex: string
    }

export async function collectRenames(
  git: GitRunner,
  cwd: string,
  span: RenameSpan,
  warn: WarnFn,
): Promise<GitRenameMap | null> {
  const between =
    "head" in span ? `${span.base}..${span.head}` : `${span.base} against the working tree`
  let stdout: string
  try {
    const result =
      "head" in span
        ? await git.run([...NAME_STATUS, `${span.base}..${span.head}`], { cwd })
        : await diffWorkingTree(git, cwd, span, between, warn)
    stdout = result.stdout
    const said = result.stderr.trim()
    if (said.length > 0) {
      warn(
        `⚠ git reported while collecting renames for ${between}: ${said}. ` +
          `Rename hints may be missing (raise diff.renameLimit if it says so); moves without one are reported as removed + added, ${RENAMED_AND_SKIPPED}.`,
      )
    }
  } catch (error) {
    warn(
      `⚠ Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  // Outside the `try`, so a defect in the parser is never reported as git having failed.
  const parsed = parseRenameRecords(stdout)
  if (!parsed.ok) {
    warn(
      `⚠ git diff --name-status -z for ${between} produced a record this parser could not read ` +
        `(field ${parsed.index}: ${describeBadField(parsed.field)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  return parsed.renames
}

const NAME_STATUS: readonly string[] = ["diff", "--find-renames", "--name-status", "-z"]

/**
 * `--ignore-errors` so one path git cannot add (a name the platform reserves, one git keeps for its
 * own directory) does not keep the rest out; `--no-warn-embedded-repo` because the advice
 * git gives on an untracked repository is about committing it.
 */
const ADD_UNTRACKED: readonly string[] = [
  "add",
  "--intent-to-add",
  "--ignore-errors",
  "--no-warn-embedded-repo",
  "--",
  ":/",
]

async function diffWorkingTree(
  git: GitRunner,
  cwd: string,
  span: Extract<RenameSpan, { scratchIndex: string }>,
  between: string,
  warn: WarnFn,
): Promise<{ stdout: string; stderr: string }> {
  const ownIndex = await indexNamedBy(git, cwd, {})
  try {
    await copyFile(ownIndex, span.scratchIndex)
  } catch (error) {
    // A checkout with no index yet: git starts the scratch one empty and adds every file.
    if (errorCode(error) !== "ENOENT") throw error
  }
  // Untranslated, so the line-ending notes can be told from the rest of what git says.
  const env = { GIT_INDEX_FILE: span.scratchIndex, LC_ALL: "C" }
  const leftOut = await addUntrackedFiles(git, cwd, env, ownIndex)
  if (leftOut.length > 0) {
    warn(
      `⚠ Rename detection for ${between} may be missing files git does not track: ${leftOut}. ` +
        `A move of one without \`git mv\` is reported as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
  }
  const result = await git.run([...NAME_STATUS, span.base], { cwd, env })
  return { stdout: result.stdout, stderr: withoutLineEndingNotes(result.stderr) }
}

/** What kept files git does not track out of the scratch index; empty when none was. */
async function addUntrackedFiles(
  git: GitRunner,
  cwd: string,
  env: Readonly<Record<string, string>>,
  ownIndex: string,
): Promise<string> {
  // A runner that drops `env` would have the add write the caller's index, which a commit in
  // progress may be reading, so git is asked first which index the add would write.
  if ((await indexNamedBy(git, cwd, env)) === ownIndex) {
    return "the GitRunner did not apply GIT_INDEX_FILE from `options.env`, so git would have added them to the caller's own index"
  }
  try {
    return withoutLineEndingNotes((await git.run(ADD_UNTRACKED, { cwd, env })).stderr)
  } catch (error) {
    return withoutLineEndingNotes(errorMessage(error))
  }
}

async function indexNamedBy(
  git: GitRunner,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await git.run(["rev-parse", "--git-path", "index"], { cwd, env })
  return resolve(cwd, stdout.trim())
}

/**
 * What git said, less the notes on how it would convert a file's line endings under
 * `core.autocrlf`, which a diff reading the working tree prints for each such file and which
 * change no record. git before 2.37 put each note on two lines.
 */
function withoutLineEndingNotes(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !LINE_ENDING_NOTES.some((note) => note.test(line)))
    .join(" ")
}

const LINE_ENDING_NOTES: readonly RegExp[] = [
  /^warning: in the working copy of '.*', (?:CRLF|LF) will be replaced by (?:CRLF|LF) the next time Git touches it$/,
  /^warning: (?:CRLF|LF) will be replaced by (?:CRLF|LF) in .*\.$/,
  /^The file will have its original line endings in your working directory\.?$/,
]

const RENAMED_AND_SKIPPED =
  "and the Symbols of a renamed file one scan skipped as removed or added rather than unknown"

/** A field goes into a warning quoted and capped: it is a path, so it can carry control bytes. */
function describeBadField(field: string): string {
  const quoted = JSON.stringify(field)
  return quoted.length <= MAX_REPORTED_FIELD_LENGTH
    ? quoted
    : `${quoted.slice(0, MAX_REPORTED_FIELD_LENGTH)}…`
}

const MAX_REPORTED_FIELD_LENGTH = 120

const NAME_STATUS_FIELD = /^[A-Z]\d*$/

export type RenameRecords =
  | { ok: true; renames: GitRenameMap }
  | { ok: false; index: number; field: string }

export function parseRenameRecords(stdout: string): RenameRecords {
  const fields = stdout.split("\0")
  const tail = fields.pop()
  if (tail !== "") return { ok: false, index: fields.length, field: tail ?? "" }
  const renames = new Map<string, string>()
  let index = 0
  while (index < fields.length) {
    const status = fields[index]
    if (status === undefined || !NAME_STATUS_FIELD.test(status)) {
      return { ok: false, index, field: status ?? "" }
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    const recordIsTruncated = index + pathCount > fields.length - 1
    if (recordIsTruncated) return { ok: false, index, field: status }
    index += 1 + pathCount
    if (!status.startsWith("R")) continue
    const oldPath = fields[index - 2]
    const newPath = fields[index - 1]
    if (oldPath === undefined || newPath === undefined) return { ok: false, index, field: status }
    renames.set(oldPath.normalize("NFC"), newPath.normalize("NFC"))
  }
  return { ok: true, renames }
}
