import { errorMessage } from "../errors"
import { holdRefusedWrites } from "../output-faults"
import { runCli } from "../run"

export async function main(): Promise<void> {
  // Thrown from a stream's `error` event, a refused write would end the process at the write,
  // before `aburi diff` removes its base worktree.
  holdRefusedWrites({ stdout: process.stdout, stderr: process.stderr }, process)
  // `process.exitCode`, never `process.exit()`: exiting at once can cut off output still being
  // flushed to a pipe (`aburi scan … | head`).
  try {
    process.exitCode = await runCli({ argv: process.argv.slice(2) })
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  }
}
