// Lists text that cites something that rots — a design-doc section (`§3.4`, `ir-schema.md`), a spec id
// (`CR5`, `LP8q`), an invariant number, an issue or pull request — in code comments, test titles, every
// line of the YAML files, and the `description` of the JSON Schemas (shipped as JSDoc in @aburi/types)
// and of every package.json (shown on npm).
//
//   node scripts/check-references.mjs [pathspecs…]
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { parseSync, Visitor } from "oxc-parser"

const DOCUMENTS = execFileSync("git", ["ls-files", "docs/*.md", "CONTRIBUTING.md", "CLAUDE.md"], {
  encoding: "utf8",
})
  .split("\n")
  .map((path) => path.split("/").at(-1) ?? "")
  .filter((name) => name !== "" && name !== "index.md")
  .map((name) => name.replaceAll(".", "\\."))
const REFERENCE = new RegExp(
  [
    "§",
    String.raw`(?:^|[^&\w/])#\d+\b`,
    String.raw`\bthe issue\b`,
    String.raw`\b(?:LP|LE|MP|DF|CR|EP|CL|SV|PR|CD|ML|PT|FP|MC|PP)\d+[a-z]?\b`,
    String.raw`\binvariant\s*#?\d+`,
    String.raw`(?<![\w.-])(?:${DOCUMENTS.join("|")})\b`,
  ].join("|"),
)

const DEFAULT_PATHSPECS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.mjs",
  "*.yml",
  "*.yaml",
  "schema/*.json",
  "*package.json",
]
const patterns = process.argv.slice(2)
const files = execFileSync(
  "git",
  ["ls-files", ...(patterns.length > 0 ? patterns : DEFAULT_PATHSPECS)],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(
    (file) =>
      file &&
      existsSync(file) &&
      file !== "pnpm-lock.yaml" &&
      file !== "scripts/check-references.mjs" &&
      !file.startsWith(".claude/") &&
      !file.includes("/generated/") &&
      !/\/(projects|before|after)\//.test(file),
  )

if (files.length === 0) {
  console.error(
    `no tracked file matches ${(patterns.length > 0 ? patterns : DEFAULT_PATHSPECS).join(" ")}`,
  )
  process.exit(2)
}

let hits = 0
function report(file, line, what, body) {
  console.log(`${file}:${line} ${what}: ${body.replace(/\s+/g, " ").slice(0, 140)}`)
  hits++
}

for (const file of files) {
  const text = readFileSync(file, "utf8")
  if (/\.ya?ml$/.test(file)) scanYaml(file, text)
  else if (file.endsWith(".json")) scanSchema(file, text)
  else scanScript(file, text)
}

console.log(`\n${hits} reference(s) in ${files.length} file(s)`)
process.exitCode = hits === 0 ? 0 : 1

function scanYaml(file, text) {
  text.split("\n").forEach((line, index) => {
    if (REFERENCE.test(line)) report(file, index + 1, "yaml", line)
  })
}

function scanSchema(file, text) {
  const lines = text.split("\n")
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) visit(item, `${path}[${i}]`)
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "description" && typeof child === "string" && REFERENCE.test(child)) {
          const line = lines.findIndex((l) => l.includes(JSON.stringify(child).slice(1, 40))) + 1
          report(file, line, `description at ${path}`, child)
        }
        visit(child, `${path}/${key}`)
      }
    }
  }
  visit(JSON.parse(text), "")
}

function scanScript(file, text) {
  const { program, comments } = parseSync(file, text)
  const lineOf = (offset) => text.slice(0, offset).split("\n").length
  for (const { start, end } of comments) {
    const body = text.slice(start, end)
    if (REFERENCE.test(body)) report(file, lineOf(start), "comment", body)
  }
  new Visitor({
    CallExpression(node) {
      const title = node.arguments[0]
      if (!isTitled(node) || !isTitleText(title)) return
      const body = text.slice(title.start, title.end)
      if (REFERENCE.test(body)) report(file, lineOf(title.start), "title", body)
    },
  }).visit(program)
}

function isTitled(node) {
  let callee = node.callee
  while (callee.type === "CallExpression") callee = callee.callee
  while (callee.type === "MemberExpression") callee = callee.object
  return callee.type === "Identifier" && ["describe", "it", "test"].includes(callee.name)
}

function isTitleText(node) {
  return (
    node?.type === "TemplateLiteral" || (node?.type === "Literal" && typeof node.value === "string")
  )
}
