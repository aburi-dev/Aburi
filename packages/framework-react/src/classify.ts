import { calleeName, lastQnameSegment, type SyntaxNode } from "@aburi/core"
import type {
  Confidence,
  FrameworkClassifyContext,
  ImportEdge,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { hocReturn, isPascalCase, matchesHocNaming, returnsContextProvider } from "./components"
import { REACT_DERIVED_BY_PREFIX, type ReactExtKind } from "./ext-kinds"
import { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
import { importsComposables, importsReact, isImportBinding, isReactBinding } from "./imports"
import { containsJsx, hasJsxReturn } from "./jsx"
import {
  isContextCall,
  isForwardRefCall,
  isMemoCall,
  type WrapperCall,
  wrapperCallNode,
} from "./wrappers"

/** `extKind` narrowed to the plugin's own union so a typo fails to compile. */
type ReactClassification = { extKind: ReactExtKind; derivedBy: string; confidence: Confidence }

export function classifyReactSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  if (symbol.kind === "function") return classifyFunctionSymbol(symbol, ctx.imports)
  if (symbol.kind === "const") return classifyConstSymbol(symbol, ctx.imports)
  return null
}

// A role read off a name is React's only where the file imports React: `useCounter` is a Vue
// composable as well, and `memo` or `createContext` can be any library's.
function namedRoleConfidence(imports: readonly ImportEdge[]): Confidence {
  return importsReact(imports) ? "high" : "medium"
}

function classifyFunctionSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  imports: readonly ImportEdge[],
): ReactClassification | null {
  const leaf = lastQnameSegment(symbol.name)

  if (matchesHookNaming(leaf)) {
    const callsHook = !importsComposables(imports) && bodyCallsAnotherHook(symbol.bodyNode)
    const signals = [`${REACT_DERIVED_BY_PREFIX}:hook:naming`]
    if (callsHook) signals.push(`${REACT_DERIVED_BY_PREFIX}:hook:hook-call`)
    return {
      extKind: "framework:react:hook",
      derivedBy: signals.join(";"),
      // Calling a hook is what makes a function a hook by React's own rule, and a hook file often
      // imports only the hooks it builds on (`next/navigation`, `@tanstack/react-query`).
      confidence: callsHook ? "high" : namedRoleConfidence(imports),
    }
  }

  if (matchesHocNaming(leaf)) {
    const confidence = hocConfidence(symbol, imports)
    if (confidence === null) return null
    return {
      extKind: "framework:react:hoc",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:hoc:naming`,
      confidence,
    }
  }

  // A lowercase function that is neither hook nor HOC is a plain utility.
  if (!isPascalCase(leaf)) return null

  if (returnsContextProvider(symbol.bodyNode)) {
    return {
      extKind: "framework:react:provider",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:provider`,
      confidence: "high",
    }
  }

  if (hasJsxReturn(symbol.bodyNode)) {
    return {
      extKind: "framework:react:component",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:component`,
      confidence: "high",
    }
  }

  return null
}

// A HOC hands back a component. JSX is React's whatever the file imports, as it is for a
// component; a function or class handed back is a component by the name alone; and a call handed
// back gives back one only maybe, so it counts only beside an import of React.
function hocConfidence(
  symbol: SymbolCandidate<OpaqueAstNode>,
  imports: readonly ImportEdge[],
): Confidence | null {
  // The JSX a HOC renders is usually its wrapper's, a function it hands back.
  if (containsJsx(symbol.bodyNode)) return "high"
  const returned = hocReturn(symbol.bodyNode, parameterNames(symbol))
  if (returned === "component") return namedRoleConfidence(imports)
  if (returned === "call" && importsReact(imports)) return "medium"
  return null
}

function parameterNames(symbol: SymbolCandidate<OpaqueAstNode>): ReadonlySet<string> {
  const names = new Set<string>()
  for (const input of symbol.signature?.inputs ?? []) {
    names.add(input.name)
    for (const binding of input.bindings ?? []) names.add(binding)
  }
  return names
}

function classifyConstSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  imports: readonly ImportEdge[],
): ReactClassification | null {
  const node = wrapperCallNode(symbol.fullNode, symbol.name)
  const call = node === null ? null : calleeName(node)
  if (node === null || call === null) return null
  const role = wrapperRole(call)
  if (role === null) return null
  const confidence = wrapperConfidence(node, call, imports)
  if (confidence === null) return null
  return {
    extKind: role.extKind,
    derivedBy: `${REACT_DERIVED_BY_PREFIX}:${role.tag}:${call.name}`,
    confidence,
  }
}

function wrapperRole(call: WrapperCall): { extKind: ReactExtKind; tag: string } | null {
  if (isContextCall(call)) return { extKind: "framework:react:context", tag: "context" }
  if (isForwardRefCall(call)) return { extKind: "framework:react:forward-ref", tag: "forward-ref" }
  if (isMemoCall(call)) return { extKind: "framework:react:memo", tag: "memo" }
  return null
}

// `vm.createContext` is Node's and `createContext` from `solid-js` is Solid's: a wrapper is React's
// through a name a React import binds, or a bare name no import binds. A call handed JSX wraps a
// component whatever names it, as Chakra UI's own `forwardRef` does.
function wrapperConfidence(
  node: SyntaxNode,
  call: WrapperCall,
  imports: readonly ImportEdge[],
): Confidence | null {
  const bare = call.name === call.leaf
  const head = bare ? call.name : call.name.slice(0, call.name.indexOf("."))
  if (isReactBinding(imports, head)) return "high"
  if (containsJsx(node.childForFieldName("arguments"))) return "high"
  if (bare && !isImportBinding(imports, head)) return namedRoleConfidence(imports)
  return null
}
