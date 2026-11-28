#!/usr/bin/env node
import { readForceColor } from "../force-color"

// Node warns on stderr that FORCE_COLOR overrides NO_COLOR at the first colour check any module
// makes as it loads. FORCE_COLOR outranks both here too, so they go before the rest of the CLI
// loads, and from the environment every worker and child process it starts inherits.
if (readForceColor(process.env.FORCE_COLOR) === true) {
  delete process.env.NO_COLOR
  delete process.env.NODE_DISABLE_COLORS
}

const { main } = await import("./main")
await main()
