import type { VocabRegistry } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { describeCallee } from "./callee"
import { importedValueOf } from "./name-binding"
import { LOOP_KINDS } from "./rules"

/** What says whether a module's export never returns to its caller. */
export type ExitCalls = Pick<VocabRegistry, "isExitCall">

export const NO_EXIT_CALLS: ExitCalls = { isExitCall: () => false }

// A host older than this plugin passes a registry without `isExitCall`. Refused here, the scan ends
// naming the host, where the walk would throw in each file that calls an import and withdraw it.
export function assertAnswersExitCalls(registry: VocabRegistry): void {
  if (typeof registry.isExitCall === "function") return
  throw new Error(
    "the host's plugin registry has no isExitCall, which this @aburi/lang-typescript reads to tell whether a call returns. Update @aburi/cli to the version released with it.",
  )
}

export function containsEarlyExit(node: Node, exitCalls: ExitCalls): boolean {
  return exitsFrom(node, { ...NO_INNER_TARGETS, exitCalls })
}

interface ExitScope {
  readonly exitCalls: ExitCalls
  readonly inFunction: boolean
  readonly inLoop: boolean
  readonly inSwitch: boolean
  readonly labels: readonly string[]
}

const NO_INNER_TARGETS: Omit<ExitScope, "exitCalls"> = {
  inFunction: false,
  inLoop: false,
  inSwitch: false,
  labels: [],
}

const EXIT_BOUNDARIES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "class_static_block",
])

function exitsFrom(node: Node, scope: ExitScope): boolean {
  switch (node.type) {
    case "throw_statement":
      return true
    case "return_statement":
      if (!scope.inFunction) return true
      break
    case "break_statement":
    case "continue_statement": {
      if (scope.inFunction) return false
      const label = node.childForFieldName("label")
      if (label !== null) return !scope.labels.includes(label.text)
      return node.type === "break_statement" ? !scope.inLoop && !scope.inSwitch : !scope.inLoop
    }
    case "call_expression": {
      const callee = node.childForFieldName("function")
      if (callee !== null && callsExit(callee, scope.exitCalls)) return true
      break
    }
  }
  const inner = scopeInside(node, scope)
  for (const child of node.namedChildren) {
    if (child !== null && exitsFrom(child, inner)) return true
  }
  return false
}

function callsExit(callee: Node, exitCalls: ExitCalls): boolean {
  if (describeCallee(callee)?.target === "process.exit") return true
  // A call a plugin declares never returns is read through the import that binds it, so a local of
  // the same name does not count.
  const imported = importedValueOf(callee)
  return imported !== null && exitCalls.isExitCall(imported.module, imported.exported)
}

function scopeInside(node: Node, scope: ExitScope): ExitScope {
  if (EXIT_BOUNDARIES.has(node.type)) return { ...scope, inFunction: true }
  if (LOOP_KINDS.has(node.type)) return { ...scope, inLoop: true }
  if (node.type === "switch_statement") return { ...scope, inSwitch: true }
  if (node.type === "labeled_statement") {
    const label = node.childForFieldName("label")
    if (label !== null) return { ...scope, labels: [...scope.labels, label.text] }
  }
  return scope
}
