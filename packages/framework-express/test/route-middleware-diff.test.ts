import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffIRs, diffOfEditWith, scanWith } from "@aburi/test-harness"
import { changeLines, soleChange, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SymbolChanged } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { expressFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("route-middleware")

const SOURCE = "src/routes.ts"

const lineup = { languages: [langTypescriptPlugin], frameworks: [expressFrameworkPlugin] }

const routes = (registration: string) =>
  [
    'import { Router } from "express"',
    'import { audit, requireAdmin } from "./middleware"',
    "export const router = Router()",
    registration,
    "",
  ].join("\n")

const usersRoute = (...middleware: string[]) =>
  routes(
    `router.get("/users", ${[...middleware, "async (_req, res) => {\n  res.json([])\n}"].join(", ")})`,
  )

function onlyChange(diff: DiffResult): SymbolChanged {
  expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
  return soleChange(diff.symbols, "changed")
}

describe("diff — a route's middleware", () => {
  it.each([
    ["removed", ["requireAdmin"], [], { added: [], removed: ["requireAdmin"], reordered: false }],
    ["added", [], ["requireAdmin"], { added: ["requireAdmin"], removed: [], reordered: false }],
    [
      "reordered",
      ["requireAdmin", "audit"],
      ["audit", "requireAdmin"],
      { added: [], removed: [], reordered: true },
    ],
    [
      "swapped for another",
      ["requireAdmin"],
      ["audit"],
      { added: ["audit"], removed: ["requireAdmin"], reordered: false },
    ],
  ])("is a logic change when one is %s", async (_edit, before, after, middleware) => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      usersRoute(...before),
      usersRoute(...after),
    )

    const change = onlyChange(diff)
    expect(change.after.id).toBe("ts:src/routes.ts#router__get__$users__d0")
    expect(change.delta).toMatchObject({ logicChanged: true, middleware })
  })

  it("reports the middleware as unchanged when only the handler's body moved", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      routes(`router.get("/users", requireAdmin, async (_req, res) => {\n  res.json([])\n})`),
      routes(`router.get("/users", requireAdmin, async (_req, res) => {\n  res.json([1])\n})`),
    )

    expect(onlyChange(diff).delta.middleware).toEqual({ added: [], removed: [], reordered: false })
  })

  it("leaves the middleware out of a route that names none on either side", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      routes(`router.get("/users", async (_req, res) => {\n  res.json([])\n})`),
      routes(`router.get("/users", async (_req, res) => {\n  res.json([1])\n})`),
    )

    expect(onlyChange(diff).delta).not.toHaveProperty("middleware")
  })

  it("is no change when the middleware is only rewrapped and commented", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      usersRoute("requireAdmin", "audit"),
      usersRoute("requireAdmin /* gate */", "\n  audit"),
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 2 })
  })

  it("is a logic change when a mount loses the middleware in front of its router", async () => {
    const mount = (...middleware: string[]) =>
      routes(`router.use("/admin", ${[...middleware, "adminRouter"].join(", ")})`)
    const { diff } = await diffOfEditWith(workspace, lineup, SOURCE, mount("requireAdmin"), mount())

    expect(onlyChange(diff).delta).toMatchObject({
      logicChanged: true,
      middleware: { added: [], removed: ["requireAdmin"], reordered: false },
    })
  })

  it.each([
    [
      "of another method and path",
      [`router.get("/a", requireAdmin, listA)`],
      [`router.post("/b", requireAdmin, createB)`],
    ],
    [
      "while a third route keeps that middleware",
      [`router.get("/a", requireAdmin, listA)`, `router.get("/x", requireAdmin, listX)`],
      [`router.delete("/zzz", requireAdmin, removeZ)`, `router.get("/x", requireAdmin, listX)`],
    ],
  ])(
    "does not pair a removed route with an added one that shares only its middleware, %s",
    async (_case, before, after) => {
      const { diff } = await diffOfEditWith(
        workspace,
        lineup,
        SOURCE,
        routes(before.join("\n")),
        routes(after.join("\n")),
      )

      expect(diff.summary).toMatchObject({ added: 1, removed: 1, moved: 0, movedChanged: 0 })
    },
  )

  it("does not pair a route removed from one file with one added to another that shares only its middleware", async () => {
    await workspace.writeSource("src/one.ts", routes(`router.get("/a", requireAdmin, listA)`))
    await workspace.writeSource("src/two.ts", routes(""))
    const base = await scanWith(workspace.root, lineup)
    await workspace.writeSource("src/one.ts", routes(""))
    await workspace.writeSource("src/two.ts", routes(`router.put("/b", requireAdmin, updateB)`))
    const head = await scanWith(workspace.root, lineup)

    const diff = diffIRs(base.ir, head.ir)
    expect(changeLines(diff.symbols).filter((line) => !line.startsWith("unchanged"))).toEqual([
      "added ts:src/two.ts#router__put__$b__d0",
      "removed ts:src/one.ts#router__get__$a__d0",
    ])
  })
})
