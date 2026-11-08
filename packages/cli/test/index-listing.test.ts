import { describe, expect, it } from "vitest"
import { pathsWithMode } from "../src/git/index-listing"

const decomposed = "docs/café"

const LISTING = [
  "100644 aaa 0\tsrc/main.ts",
  "120000 bbb 0\tsrc/z-link.ts",
  "160000 ccc 0\tlibs/sub",
  "100755 ddd 0\tbin/run",
  "120000 eee 0\tsrc/a\tb\nc",
  "160000 fff 1\tlibs/conflicted",
  "160000 ggg 2\tlibs/conflicted",
  `120000 hhh 0\t${decomposed}`,
  "100644 iii 0\t120000 jjj 0\tnot-a-link",
  "",
].join("\0")

describe("pathsWithMode", () => {
  it.each([
    ["120000", [decomposed, "src/a\tb\nc", "src/z-link.ts"]],
    ["160000", ["libs/conflicted", "libs/sub"]],
  ] as const)(
    "lists the %s entries once each, sorted, spelled as git wrote them",
    (mode, paths) => {
      expect(pathsWithMode(LISTING, mode)).toEqual(paths)
    },
  )
})
