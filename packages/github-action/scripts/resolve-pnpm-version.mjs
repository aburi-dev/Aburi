import { readFileSync } from "node:fs"
import { join } from "node:path"

const UNPINNED_VERSION = "10"

/**
 * Whether the root package.json pins pnpm, read as pnpm/action-setup reads it: that action refuses
 * a `version` beside a `packageManager` pin that differs from it, a major alone included, and takes
 * a pin with an empty version for no pin at all.
 */
function pinsPnpm(workspace) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  } catch {
    // No manifest, or one pnpm/action-setup will refuse to parse in its own words.
    return false
  }
  if (manifest === null || typeof manifest !== "object") return false
  const engine = manifest.devEngines?.packageManager
  if (engine?.name === "pnpm" && typeof engine.version === "string" && engine.version !== "") {
    return true
  }
  const { packageManager } = manifest
  return (
    typeof packageManager === "string" &&
    packageManager.startsWith("pnpm@") &&
    packageManager.slice("pnpm@".length).split("+")[0] !== ""
  )
}

function main() {
  const requested = process.env.PNPM_VERSION ?? ""
  if (requested !== "") {
    process.stdout.write(requested)
    return
  }
  const workspace = process.env.GITHUB_WORKSPACE ?? ""
  // Nothing for a pin: pnpm/action-setup then installs the pinned version itself.
  process.stdout.write(workspace !== "" && pinsPnpm(workspace) ? "" : UNPINNED_VERSION)
}

main()
