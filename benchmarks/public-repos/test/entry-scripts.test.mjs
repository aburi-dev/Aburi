import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))

// Nothing else imports these scripts, so an export one of them lost would surface only when run.
describe("the entry scripts", () => {
  it.each([
    ["census.mjs shares", 0, /^\| Category \| Needs types \|/m],
    ["run.mjs --bogus", 1, /Unknown flag: --bogus/],
  ])("%s loads every module it imports and answers", (command, status, says) => {
    const [script, ...args] = command.split(" ")
    const result = spawnSync(process.execPath, [resolve(HERE, "..", script), ...args], {
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(result.stderr).not.toMatch(/SyntaxError/)
    expect(`${result.stdout}${result.stderr}`).toMatch(says)
    expect(result.status).toBe(status)
  })
})
