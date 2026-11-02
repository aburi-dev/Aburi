import { describe, expect, it } from "vitest"
import changelog from "../src/index.mjs"

const dependencies = [
  { name: "@aburi/core", newVersion: "0.6.0" },
  { name: "@aburi/types", newVersion: "0.6.0" },
]

function changesets(count, commitOf) {
  return Array.from({ length: count }, (_, index) => ({
    id: `changeset-${index}`,
    commit: commitOf(index),
    summary: `Change ${index}`,
    releases: [],
  }))
}

describe("getDependencyReleaseLine", () => {
  it.each([
    ["one changeset", changesets(1, () => "bb90fea7b35ef2262d4edc0e32600846bbcd34ce")],
    [
      "41 changesets, several sharing a commit",
      changesets(41, (index) => `${String(index % 30).padStart(7, "0")}${"f".repeat(33)}`),
    ],
    ["changesets with no commit", changesets(3, () => undefined)],
  ])("names each dependency once at its new version, in one line, for %s", async (_, bumps) => {
    await expect(changelog.getDependencyReleaseLine(bumps, dependencies, null)).resolves.toBe(
      "- Updated dependencies: `@aburi/core@0.6.0`, `@aburi/types@0.6.0`",
    )
  })

  it("names the dependencies in name order, whatever order the release plan lists them in", async () => {
    const unordered = [
      { name: "@aburi/types", newVersion: "0.6.1" },
      { name: "@aburi/config", newVersion: "0.4.2" },
      { name: "@aburi/core", newVersion: "0.6.1" },
    ]
    await expect(
      changelog.getDependencyReleaseLine(
        changesets(1, () => undefined),
        unordered,
        null,
      ),
    ).resolves.toBe(
      "- Updated dependencies: `@aburi/config@0.4.2`, `@aburi/core@0.6.1`, `@aburi/types@0.6.1`",
    )
  })

  it("writes nothing for a release that picked up no dependency", async () => {
    await expect(
      changelog.getDependencyReleaseLine(
        changesets(2, () => undefined),
        [],
        null,
      ),
    ).resolves.toBe("")
  })
})
