// Find structurally similar test cases. similarity-ts compares named functions only, so every
// it()/test() callback is first mirrored into a temp directory as a named function, and the pairs it
// reports are mapped back to file:line and title.
//
//   node .claude/skills/code-hygiene/scripts/similar-tests.mjs [--threshold 0.9] [--min-lines 4] [pathspecs…]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSync, Visitor } from "oxc-parser"

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const [value] = args.splice(i, 2).slice(1)
  return value
}
const threshold = option("--threshold", "0.9")
const minLines = option("--min-lines", "4")
const patterns = args.length > 0 ? args : ["packages/*/test/*.test.ts", "examples/test/*.test.ts"]

const files = execFileSync("git", ["ls-files", ...patterns], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file && existsSync(file))

const mirror = mkdtempSync(join(tmpdir(), "aburi-similar-tests-"))
const titles = new Map()
let count = 0

function calleeName(node) {
  let callee = node.callee
  while (callee.type === "CallExpression") callee = callee.callee
  while (callee.type === "MemberExpression") callee = callee.object
  return callee.type === "Identifier" ? callee.name : null
}

for (const file of files) {
  const text = readFileSync(file, "utf8")
  const out = []
  new Visitor({
    CallExpression(node) {
      if (!["it", "test"].includes(calleeName(node))) return
      const fn = node.arguments.find(
        (a) => a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression",
      )
      if (fn?.body.type !== "BlockStatement") return
      const name = `t${++count}`
      const line = text.slice(0, node.start).split("\n").length
      const title = node.arguments[0]
      titles.set(name, `${file}:${line} ${text.slice(title.start, title.end).slice(0, 110)}`)
      out.push(`async function ${name}() ${text.slice(fn.body.start, fn.body.end)}\n`)
    },
  }).visit(parseSync(file, text).program)
  if (out.length > 0) {
    mkdirSync(mirror, { recursive: true })
    writeFileSync(join(mirror, file.replaceAll("/", "__")), out.join("\n"))
  }
}

let report = ""
try {
  report = execFileSync(
    "similarity-ts",
    [mirror, "--threshold", threshold, "--min-lines", minLines, "--no-types"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
} finally {
  rmSync(mirror, { recursive: true, force: true })
}

const pairs = report
  .split(/\n(?=Similarity:)/)
  .filter((block) => block.startsWith("Similarity:"))
  .map((block) => ({
    similarity: block.match(/Similarity: ([\d.]+)%/)?.[1],
    cases: [...block.matchAll(/ (t\d+)\s*$/gm)].map((m) => titles.get(m[1])),
  }))
  .filter((pair) => pair.cases.length === 2)

console.log(`${count} test cases compared; ${pairs.length} similar pair(s) at >= ${threshold}\n`)
for (const { similarity, cases } of pairs)
  console.log(`${similarity}%\n  ${cases[0]}\n  ${cases[1]}\n`)
