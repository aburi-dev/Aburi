import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Every call runs the CLI, and a diff scans twice; a cancelled run is given five seconds.
      testTimeout: 60_000,
    },
  }),
)
