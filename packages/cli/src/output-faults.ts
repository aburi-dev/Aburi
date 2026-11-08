import { errorCode, errorMessage } from "./errors"

type OutputStream = "stdout" | "stderr"

interface OutputSink {
  on(event: "error", listener: (error: unknown) => void): unknown
  write(text: string): unknown
}

interface ExitingProcess {
  once(event: "beforeExit", listener: () => void): unknown
  exitCode?: NodeJS.Process["exitCode"]
}

export function holdRefusedWrites(
  streams: Readonly<Record<OutputStream, OutputSink>>,
  host: ExitingProcess,
): void {
  let refused: { stream: OutputStream; reason: string } | null = null
  for (const name of ["stdout", "stderr"] as const) {
    streams[name].on("error", (error: unknown) => {
      // EPIPE is a reader that stopped early, not a failure of the run. Past the first refusal, a
      // stdio stream revived after its error fails each later write again, the notice's included.
      if (refused !== null || errorCode(error) === "EPIPE") return
      refused = { stream: name, reason: errorMessage(error) }
    })
  }
  // `beforeExit` rather than after the run: a stream reports a refused write on a later tick, so
  // the error can arrive after the run returned. `once`, since the notice's write re-arms it.
  host.once("beforeExit", () => {
    if (refused === null) return
    host.exitCode = 1
    const other: OutputStream = refused.stream === "stdout" ? "stderr" : "stdout"
    streams[other].write(`aburi: could not write to ${refused.stream}: ${refused.reason}\n`)
  })
}
