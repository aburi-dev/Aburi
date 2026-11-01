import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { diffIRs } from "@aburi/test-harness"
import { editFile } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { evaluateFailOn, parseFailOn } from "../../src"
import { scanFixture, useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout()

describe("e2e diff — logger.service.ts moved under common/logging/", () => {
  it("classifies the move as moved:N with no add/remove/changed and does not trip a removed/dropped-toggled gate", async () => {
    const baseIR = (await scanFixture(fixture.root)).ir

    const oldPath = resolve(fixture.root, "src/common/logger.service.ts")
    const newPath = resolve(fixture.root, "src/common/logging/logger.service.ts")
    const original = await readFile(oldPath, "utf8")
    await mkdir(dirname(newPath), { recursive: true })
    await writeFile(newPath, original, "utf8")
    await rm(oldPath)

    for (const importer of ["src/app.module.ts", "src/billing/billing.service.ts"]) {
      await editFile(
        resolve(fixture.root, importer),
        'common/logger.service"',
        'common/logging/logger.service"',
      )
    }

    const headIR = (await scanFixture(fixture.root)).ir
    const diff = diffIRs(baseIR, headIR)

    expect(diff.summary.moved).toBeGreaterThan(0)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.droppedToggled).toBe(0)

    const moved = diff.symbols.filter((c) => c.status === "moved" || c.status === "moved+changed")
    expect(moved.length).toBeGreaterThan(0)
    for (const change of moved) {
      expect(
        change.before.source.file,
        `moved symbol ${change.before.id} should originate from the old logger.service.ts path`,
      ).toMatch(/common\/logger\.service\.ts$/)
    }

    const triggered = evaluateFailOn(parseFailOn("removed,dropped-toggled"), diff)
    expect(triggered.firstTriggered).toBeNull()
  })
})
