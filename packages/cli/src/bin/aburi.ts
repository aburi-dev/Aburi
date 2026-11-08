#!/usr/bin/env node
import { errorMessage } from "../errors"
import { holdRefusedWrites } from "../output-faults"
import { runCli } from "../run"

// Thrown from a stream's `error` event, a refused write would end the process at the write, before
// `aburi diff` removes its base worktree.
holdRefusedWrites({ stdout: process.stdout, stderr: process.stderr }, process)

// `process.exitCode`, never `process.exit()`: exiting at once can cut off output still being
// flushed to a pipe (`aburi scan … | head`).
async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
})
