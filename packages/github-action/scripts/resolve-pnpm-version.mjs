import { readFileSync } from "node:fs"
import { join } from "node:path"

const UNPINNED_VERSION = "10"

/**
 * The pnpm version the root package.json pins, read as pnpm/action-setup reads it, which refuses a
 * `version` beside a `packageManager` pin that differs from it, a major alone included.
 */
function pinnedPnpm(workspace) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  } catch {
    // No manifest, or one pnpm/action-setup will refuse to parse in its own words.
    return null
  }
  if (manifest === null || typeof manifest !== "object") return null
  const { packageManager, devEngines } = manifest
  if (typeof packageManager === "string" && packageManager.startsWith("pnpm@")) {
    return packageManager.slice("pnpm@".length).split("+")[0]
  }
  const engine = devEngines?.packageManager
  if (engine?.name === "pnpm" && typeof engine.version === "string" && engine.version !== "") {
    return engine.version
  }
  return null
}

function main() {
  const requested = process.env.PNPM_VERSION ?? ""
  if (requested !== "") {
    process.stdout.write(requested)
    return
  }
  const workspace = process.env.GITHUB_WORKSPACE ?? ""
  const pinned = workspace === "" ? null : pinnedPnpm(workspace)
  // Nothing for a pin: pnpm/action-setup then installs the pinned version itself.
  process.stdout.write(pinned === null ? UNPINNED_VERSION : "")
}

main()
