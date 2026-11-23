import { lastQnameSegment } from "@aburi/core"
import type {
  Confidence,
  FrameworkClassifyContext,
  ImportEdge,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { hasHocBody, isPascalCase, matchesHocNaming, returnsContextProvider } from "./components"
import { REACT_DERIVED_BY_PREFIX, type ReactExtKind } from "./ext-kinds"
import { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
import { importsReact, isReactBinding } from "./imports"
import { hasJsxReturn } from "./jsx"
import {
  extractWrapperCall,
  isContextCall,
  isForwardRefCall,
  isMemoCall,
  type WrapperCall,
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
    const callsHook = bodyCallsAnotherHook(symbol.bodyNode)
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

  if (matchesHocNaming(leaf) && hasHocBody(symbol.bodyNode)) {
    return {
      extKind: "framework:react:hoc",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:hoc:naming`,
      // JSX is React's whatever the file imports, as it is for a component.
      confidence: hasJsxReturn(symbol.bodyNode) ? "high" : namedRoleConfidence(imports),
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

function classifyConstSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  imports: readonly ImportEdge[],
): ReactClassification | null {
  const call = extractWrapperCall(symbol.fullNode, symbol.name)
  if (call === null) return null
  const confidence = namedRoleConfidence(imports)
  if (isContextCall(call)) {
    if (!isReactContextCallee(call, imports)) return null
    return {
      extKind: "framework:react:context",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:context:${call.name}`,
      confidence,
    }
  }
  if (isForwardRefCall(call)) {
    return {
      extKind: "framework:react:forward-ref",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:forward-ref:${call.name}`,
      confidence,
    }
  }
  if (isMemoCall(call)) {
    return {
      extKind: "framework:react:memo",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:memo:${call.name}`,
      confidence,
    }
  }
  return null
}

// `vm.createContext` is Node's: called on a receiver, `createContext` is React's only through a
// name a React import binds.
function isReactContextCallee(call: WrapperCall, imports: readonly ImportEdge[]): boolean {
  if (call.name === call.leaf) return true
  const receiver = call.name.slice(0, call.name.length - call.leaf.length - 1)
  return isReactBinding(imports, receiver)
}
