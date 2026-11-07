import { describe, expect, it } from "vitest"
import { containsPath, resolveRepos } from "../args.mjs"

describe("containsPath", () => {
  const root = "/home/user/Aburi"

  it("rejects a work directory inside the repository", () => {
    expect(containsPath(root, "/home/user/Aburi/bench", "linux")).toBe(true)
    expect(containsPath(root, root, "linux")).toBe(true)
  })

  it("permits a sibling whose name merely starts with the repository's", () => {
    expect(containsPath(root, "/home/user/Aburi-bench", "linux")).toBe(false)
    expect(containsPath(root, "/tmp/aburi-bench-work", "linux")).toBe(false)
  })

  it("rejects a path differing from the repository only in case, as Windows resolves it", () => {
    const root = String.raw`C:\Users\u\Aburi`
    expect(containsPath(root, String.raw`c:\users\u\aburi\bench`, "win32")).toBe(true)
    expect(containsPath(root, String.raw`C:\Users\u\Aburi-bench`, "win32")).toBe(false)
  })
})

describe("resolveRepos", () => {
  const manifest = { repos: [{ id: "zod" }, { id: "nest" }] }

  it("rejects an id the manifest does not carry, rather than measuring the rest", () => {
    expect(() => resolveRepos(manifest, [" nest"])).toThrow(/ nest/)
    expect(() => resolveRepos(manifest, ["zod", "typo"])).toThrow(/typo/)
  })

  it("keeps the manifest's order rather than the order asked for", () => {
    expect(resolveRepos(manifest, ["nest", "zod"]).map((repo) => repo.id)).toEqual(["zod", "nest"])
    expect(resolveRepos(manifest, null)).toHaveLength(2)
  })
})
