import {
  ABSTRACT_DECLARATION_DERIVED_BY,
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  type ExtractionContext,
  FIELD_ASSIGNED_FUNCTION_DERIVED_BY,
  type SymbolCandidate,
  type SymbolKind,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { hasChildOfType, makeSourceRange } from "./ast-helpers"
import { layOutBodies } from "./call-symbols"
import {
  functionValuedField,
  type HeldFunction,
  instanceMemberNames,
  isConstructorMember,
  memberSymbolSegment,
} from "./class-members"
import {
  type CandidateSink,
  foldMemberGroup,
  groupMemberDeclaration,
  type MemberGroup,
} from "./declaration-merge"
import { declaredOrDefaultQname } from "./declared-name"
import { readDecorators } from "./decorators"
import { exportEvidence, exportVisibility, memberVisibility } from "./export-evidence"
import { readLeadingJsDoc } from "./leading-jsdoc"
import { classMemberQname, makeTsSymbolId } from "./qname"
import { superclassOf } from "./receiver-type"
import { buildSignature } from "./signature"

export function addClassAndMembers(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
): void {
  const { name: className, qname } = declaredOrDefaultQname(node, "class", ctx, namespacePath)
  out.add(makeClassCandidate(node, qname, exportEvidence(node), ctx))

  if (className === null) return
  for (const member of classMemberCandidates(node, ctx, [...namespacePath, className])) {
    out.add(member)
  }
}

export function makeClassCandidate(
  node: Node,
  qname: string,
  evidence: readonly string[],
  ctx: ExtractionContext,
): SymbolCandidate<Node> {
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "class",
    extKind: null,
    name: qname,
    visibility: exportVisibility(evidence),
    decorators: readDecorators(node),
    signature: null,
    source: makeSourceRange(node, ctx),
    derivedBy: [...evidence],
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
    ...classHeritageOf(node),
  }
}

/** What a class extends, and what of its own hides what it inherits. */
export function classHeritageOf(
  classNode: Node,
): Pick<SymbolCandidate<Node>, "superclass" | "instanceMembers"> {
  const superclass = superclassOf(classNode)
  if (superclass === null) return {}
  return { superclass, instanceMembers: instanceMemberNames(classNode) }
}

export function classMemberCandidates(
  classNode: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node>[] {
  const body = classNode.childForFieldName("body")
  if (body === null) return []
  const byId = new Map<string, MemberGroup>()
  for (const member of body.namedChildren) {
    if (member === null) continue
    const segment = memberSymbolSegment(classNode, member)
    if (segment === null) continue
    const held = functionValuedField(member)
    const candidate =
      held === null
        ? makeMethodCandidate(member, segment, ctx, ownerChain)
        : makeFieldFunctionCandidate(member, held, segment, ctx, ownerChain)
    groupMemberDeclaration(byId, candidate, hasChildOfType(member, "get"))
  }
  return [...byId.values()]
    .map(foldMemberGroup)
    .filter((candidate): candidate is SymbolCandidate<Node> => candidate !== null)
}

const ABSTRACT_DECLARATION = ABSTRACT_DECLARATION_DERIVED_BY

function makeMethodCandidate(
  node: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const kind: SymbolKind = isConstructorMember(node) ? "constructor" : "method"
  const isStatic = hasChildOfType(node, "static")
  const qname =
    kind === "constructor"
      ? classMemberQname(ownerChain, "constructor", "instance")
      : classMemberQname(ownerChain, segment, isStatic ? "static" : "instance")
  const derivedBy: string[] = [isStatic ? "static-method" : "class-method"]
  if (kind === "constructor") derivedBy.push("constructor-declaration")
  if (node.type === "abstract_method_signature") derivedBy.push(ABSTRACT_DECLARATION)
  if (hasChildOfType(node, "get") || hasChildOfType(node, "set")) {
    derivedBy.push("accessor-declaration")
  }
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind,
    extKind: null,
    name: qname,
    visibility: memberVisibility(node),
    decorators: readDecorators(node),
    signature: buildSignature(node, readLeadingJsDoc(node)),
    source: makeSourceRange(node, ctx),
    derivedBy,
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

function makeFieldFunctionCandidate(
  field: Node,
  held: HeldFunction,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const isStatic = hasChildOfType(field, "static")
  const qname = classMemberQname(ownerChain, segment, isStatic ? "static" : "instance")
  const spelling =
    held.kind === "function"
      ? FIELD_ASSIGNED_FUNCTION_DERIVED_BY
      : CALL_ARGUMENT_FUNCTION_DERIVED_BY
  const derivedBy = [isStatic ? "static-method" : "class-method", spelling]
  if (hasChildOfType(field, "accessor")) derivedBy.push("accessor-declaration")
  const member: Omit<SymbolCandidate<Node>, "signature" | "bodyNode" | "fullNode"> = {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: memberVisibility(field),
    decorators: readDecorators(field),
    source: makeSourceRange(field, ctx),
    derivedBy,
  }
  if (held.kind === "function") {
    return {
      ...member,
      signature: buildSignature(held.fn, readLeadingJsDoc(field)),
      bodyNode: held.fn.childForFieldName("body"),
      fullNode: held.fn,
    }
  }
  return { ...member, signature: null, ...layOutBodies(held.bodies, field) }
}
