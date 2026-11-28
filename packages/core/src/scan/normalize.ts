import type {
  CallCandidate,
  ImportEdge,
  OpaqueAstNode,
  Reexport,
  RelativePath,
  SymbolCandidate,
  WrittenImportEdge,
} from "@aburi/types"
import { toNfc } from "../codepoints"
import { documentPathOrViolation, type GrammarViolation } from "../id"

/**
 * A refused `source.file` is a path the plugin built: `ctx.file.path` was minted at discovery. So
 * the refusal names the plugin, and is handed back for the file's withdrawal rather than thrown.
 */
export function normalizeCandidates(
  written: readonly SymbolCandidate<OpaqueAstNode>[],
  plugin: string,
): SymbolCandidate<OpaqueAstNode>[] | GrammarViolation {
  const subject = `${plugin}'s SymbolCandidate.source.file`
  const candidates: SymbolCandidate<OpaqueAstNode>[] = []
  for (const candidate of written) {
    const file = documentPathOrViolation(candidate.source.file, subject)
    if (typeof file !== "string") return file
    candidates.push(normalizeCandidateStrings(candidate, file))
  }
  return candidates
}

function normalizeCandidateStrings(
  candidate: SymbolCandidate<OpaqueAstNode>,
  file: RelativePath,
): SymbolCandidate<OpaqueAstNode> {
  const writtenName = candidate.name
  const name = typeof writtenName === "string" ? toNfc(writtenName) : writtenName
  const derivedBy = Array.isArray(candidate.derivedBy)
    ? mapPreservingIdentity(candidate.derivedBy, (token) =>
        typeof token === "string" ? toNfc(token) : token,
      )
    : candidate.derivedBy
  const signature = normalizeSignatureStrings(candidate.signature)
  const decorators = normalizeDecoratorNames(candidate.decorators)
  const written = candidate.superclass
  const superclass = typeof written === "string" ? toNfc(written) : written
  const writtenValueType = candidate.valueType
  const valueType =
    typeof writtenValueType === "string" ? toNfc(writtenValueType) : writtenValueType
  const writtenReturns = candidate.returns
  const returns = normalizeReturnedValue(writtenReturns)
  const members = candidate.instanceMembers
  const instanceMembers = Array.isArray(members)
    ? mapPreservingIdentity(members, (name) => (typeof name === "string" ? toNfc(name) : name))
    : members
  if (
    file === candidate.source.file &&
    name === writtenName &&
    derivedBy === candidate.derivedBy &&
    signature === candidate.signature &&
    decorators === candidate.decorators &&
    superclass === written &&
    instanceMembers === members &&
    valueType === writtenValueType &&
    returns === writtenReturns
  ) {
    return candidate
  }
  const next: SymbolCandidate<OpaqueAstNode> = {
    ...candidate,
    name,
    derivedBy,
    source: { ...candidate.source, file },
    signature,
    decorators,
  }
  if (superclass !== undefined) next.superclass = superclass
  if (instanceMembers !== undefined) next.instanceMembers = instanceMembers
  if (valueType !== undefined) next.valueType = valueType
  if (returns !== undefined) next.returns = returns
  return next
}

// A plugin outside the tree may write anything here: what is not a string is left for the reader
// to refuse.
function normalizeReturnedValue<T>(written: T): T {
  if (typeof written !== "object" || written === null) return written
  const value: Record<string, unknown> = { ...(written as Record<string, unknown>) }
  let changed = false
  for (const key of ["type", "reference"]) {
    const text = value[key]
    if (typeof text !== "string" || toNfc(text) === text) continue
    value[key] = toNfc(text)
    changed = true
  }
  const call = normalizeCallSiteRef(value.call)
  if (call !== value.call) {
    value.call = call
    changed = true
  }
  return changed ? (value as T) : written
}

function mapPreservingIdentity<L extends readonly unknown[]>(
  items: L,
  transform: (item: L[number]) => L[number],
): L {
  let changed = false
  const next = items.map((item) => {
    const out = transform(item)
    if (out !== item) changed = true
    return out
  })
  return changed ? (next as unknown as L) : items
}

function normalizeDecoratorNames(
  decorators: SymbolCandidate<OpaqueAstNode>["decorators"],
): SymbolCandidate<OpaqueAstNode>["decorators"] {
  return mapPreservingIdentity(decorators, (decorator) => {
    const name = toNfc(decorator.name)
    const written = decorator.qualifier
    const qualifier = typeof written === "string" ? toNfc(written) : written
    if (name === decorator.name && qualifier === written) return decorator
    const next = { ...decorator, name }
    if (qualifier !== undefined) next.qualifier = qualifier
    return next
  })
}

function normalizeSignatureStrings<T extends SymbolCandidate<OpaqueAstNode>["signature"]>(
  signature: T,
): T {
  if (signature === null || signature === undefined) return signature
  const inputs = mapPreservingIdentity(signature.inputs, (input) => {
    const name = toNfc(input.name)
    const written = input.bindings
    if (written === undefined) return name === input.name ? input : { ...input, name }
    const bindings = mapPreservingIdentity(written, toNfc)
    return name === input.name && bindings === written ? input : { ...input, name, bindings }
  })
  return inputs === signature.inputs ? signature : ({ ...signature, inputs } as T)
}

export function normalizeImportEdge(written: WrittenImportEdge): ImportEdge {
  const source = toNfc(written.source)
  const binding = written.namespaceBinding
  const namespaceBinding = typeof binding === "string" ? toNfc(binding) : binding
  const symbols =
    written.symbols === "*" ? written.symbols : mapPreservingIdentity(written.symbols, toNfc)
  const reexports =
    written.reexports === undefined
      ? undefined
      : mapPreservingIdentity(written.reexports, normalizeReexport)
  if (
    !("origins" in written) &&
    !("upstream" in written) &&
    source === written.source &&
    namespaceBinding === binding &&
    symbols === written.symbols &&
    reexports === written.reexports
  ) {
    return written
  }
  const next: ImportEdge = { source, symbols, line: written.line, dynamic: written.dynamic }
  if (namespaceBinding !== undefined) next.namespaceBinding = namespaceBinding
  if (reexports !== undefined) next.reexports = reexports
  if (written.reexportsAll !== undefined) next.reexportsAll = written.reexportsAll
  return next
}

function normalizeReexport(reexport: Reexport): Reexport {
  const imported = toNfc(reexport.imported)
  const exported = toNfc(reexport.exported)
  return imported === reexport.imported && exported === reexport.exported
    ? reexport
    : { imported, exported }
}

export function normalizeCallStrings(call: CallCandidate): CallCandidate {
  const target = toNfc(call.target)
  const written = call.receiverType
  const receiverType = typeof written === "string" ? toNfc(written) : written
  const writtenCall = call.receiverCall
  const receiverCall = normalizeCallSiteRef(writtenCall)
  if (target === call.target && receiverType === written && receiverCall === writtenCall) {
    return call
  }
  const next: CallCandidate = { ...call, target }
  if (receiverType !== undefined) next.receiverType = receiverType
  if (receiverCall !== undefined) next.receiverCall = receiverCall
  return next
}

function normalizeCallSiteRef<T>(written: T): T {
  if (typeof written !== "object" || written === null || !("target" in written)) return written
  const { target } = written
  if (typeof target !== "string" || toNfc(target) === target) return written
  return { ...written, target: toNfc(target) }
}
