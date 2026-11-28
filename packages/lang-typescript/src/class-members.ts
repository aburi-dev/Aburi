import { decodeStringLiteral, isQnameSegment, unwrapValue } from "@aburi/core"
import type { Node } from "web-tree-sitter"
import {
  asFunctionValue,
  hasChildOfType,
  hasErrorChild,
  isExportAssignment,
  nameFieldText,
  walkDescendants,
} from "./ast-helpers"
import { handedFunctions, wrappedFunctions } from "./call-symbols"
import { assignedValueName } from "./name-binding"

const CONSTRUCTION_SEGMENT = "constructor"

function memberNameSegment(member: Node): string | null {
  return writtenNameSegment(member, member.childForFieldName("name"))
}

export function writtenNameSegment(owner: Node, name: Node | null): string | null {
  if (hasErrorChild(owner)) return null
  if (name === null) return null
  if (name.type === "property_identifier") return admitSegment(name.text)
  if (name.type === "private_property_identifier") return admitSegment(name.text, true)
  if (name.type !== "string") return null
  const { value, whole } = decodeStringLiteral(name)
  return whole ? admitSegment(value) : null
}

function admitSegment(candidate: string, privateName = false): string | null {
  return isQnameSegment(candidate, { privateName }) ? candidate : null
}

// A class expression's own name binds nothing in the module, so only a binding names its members, or
// `export =`, which has no declaring form and so takes the class's own name for the module's value.
function namesItsMembers(classNode: Node): boolean {
  if (classNode.type !== "class") return nameFieldText(classNode) !== null
  let value = classNode
  while (value.parent !== null && unwrapValue(value.parent).id === classNode.id)
    value = value.parent
  if (isExportAssignment(value.parent)) return assignedValueName(classNode, value.parent) !== null
  return isHeldByBinding(value)
}

function isHeldByBinding(value: Node): boolean {
  const declarator = value.parent
  return (
    declarator?.type === "variable_declarator" &&
    declarator.childForFieldName("value")?.id === value.id &&
    declarator.childForFieldName("name")?.type === "identifier" &&
    nameFieldText(declarator) !== null
  )
}

export function memberSymbolSegment(classNode: Node, member: Node): string | null {
  if (!namesItsMembers(classNode)) return null
  const segment = memberNameSegment(member)
  if (segment === null) return null
  if (member.type === "method_definition") return segment
  if (member.type === "abstract_method_signature") return segment
  if (member.type === "method_signature") return segment
  return functionValuedField(member) === null ? null : segment
}

/**
 * Bodies read as running when the member is called, not on construction or definition: a call
 * handed a function is taken for a wrapper unless its name says it runs or schedules it.
 */
export type HeldFunction =
  | { readonly kind: "function"; readonly fn: Node }
  | { readonly kind: "handed-to-a-call"; readonly bodies: readonly [Node, ...Node[]] }

export function functionValuedField(member: Node): HeldFunction | null {
  if (member.type !== "public_field_definition") return null
  const segment = memberNameSegment(member)
  if (segment === null || segment === CONSTRUCTION_SEGMENT) return null
  return functionAFieldHolds(member)
}

function functionAFieldHolds(field: Node): HeldFunction | null {
  const value = field.childForFieldName("value")
  if (value === null) return null
  const fn = asFunctionValue(value)
  if (fn !== null) return { kind: "function", fn }
  const [lead, ...rest] = wrappedFunctions(value)
  return lead === undefined ? null : { kind: "handed-to-a-call", bodies: [lead, ...rest] }
}

/** Whether the field's value runs a function it holds, whenever that is, which no data model does. */
export function fieldHoldsAFunction(field: Node): boolean {
  const value = field.childForFieldName("value")
  return value !== null && (asFunctionValue(value) !== null || handedFunctions(value).length > 0)
}

export function heldFunctionBodies(held: HeldFunction): Node[] {
  if (held.kind === "handed-to-a-call") return [...held.bodies]
  const body = held.fn.childForFieldName("body")
  return body === null ? [] : [body]
}

export function isConstructorMember(member: Node): boolean {
  if (hasChildOfType(member, "static")) return false
  return memberNameSegment(member) === CONSTRUCTION_SEGMENT
}

export function hasPrivateName(member: Node): boolean {
  return member.childForFieldName("name")?.type === "private_property_identifier"
}

const PARAMETER_PROPERTY_MODIFIERS = ["accessibility_modifier", "override_modifier", "readonly"]

/** A constructor parameter that declares a field too: `private`, `readonly`, `override` and the like. */
export function isParameterProperty(parameter: Node): boolean {
  return PARAMETER_PROPERTY_MODIFIERS.some((modifier) => hasChildOfType(parameter, modifier))
}

const NAMED_INSTANCE_MEMBERS: ReadonlySet<string> = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "public_field_definition",
])

/** Every instance member the class declares by name, a Symbol or not. */
export function instanceMemberNames(classNode: Node): string[] {
  const names = new Set<string>()
  for (const member of classNode.childForFieldName("body")?.namedChildren ?? []) {
    if (member === null || hasChildOfType(member, "static")) continue
    if (isConstructorMember(member)) {
      for (const name of parameterPropertyNames(member)) names.add(name)
    } else if (NAMED_INSTANCE_MEMBERS.has(member.type) && !isTypeOnlyField(member)) {
      const name = memberNameSegment(member)
      if (name !== null) names.add(name)
    }
    for (const name of thisAssignedNames(member)) names.add(name)
  }
  return [...names]
}

// TypeScript emits nothing for such a field unless it defines class fields, so it is how a subclass
// narrows the type of a member it inherits (`subscribe!: Narrowed`); a decorator may set it.
function isTypeOnlyField(member: Node): boolean {
  return (
    member.type === "public_field_definition" &&
    member.childForFieldName("value") === null &&
    member.childForFieldName("type") !== null &&
    member.childForFieldName("decorator") === null &&
    !hasChildOfType(member, "accessor") &&
    !hasChildOfType(member, "abstract")
  )
}

function parameterPropertyNames(construction: Node): string[] {
  const names: string[] = []
  for (const parameter of construction.childForFieldName("parameters")?.namedChildren ?? []) {
    const pattern = parameter?.childForFieldName("pattern")
    if (parameter && pattern?.type === "identifier" && isParameterProperty(parameter)) {
      names.push(pattern.text)
    }
  }
  return names
}

const THIS_BINDERS: ReadonlySet<string> = new Set([
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "class",
  "class_declaration",
  "abstract_class_declaration",
])

const ASSIGNMENTS: ReadonlySet<string> = new Set([
  "assignment_expression",
  "augmented_assignment_expression",
])

// What an instance member's code assigns to `this`, in a method's body or a field's value, outside
// a function or class that binds a `this` of its own.
function thisAssignedNames(member: Node): string[] {
  const code =
    member.type === "method_definition"
      ? member.childForFieldName("body")
      : member.type === "public_field_definition"
        ? member.childForFieldName("value")
        : null
  if (code === null || THIS_BINDERS.has(code.type)) return []
  const names: string[] = []
  const descend = (node: Node): boolean => !THIS_BINDERS.has(node.type)
  for (const node of walkDescendants(code, { descend })) {
    if (!ASSIGNMENTS.has(node.type)) continue
    const left = node.childForFieldName("left")
    if (left?.type !== "member_expression") continue
    if (left.childForFieldName("object")?.type !== "this") continue
    const name = writtenNameSegment(left, left.childForFieldName("property"))
    if (name !== null) names.push(name)
  }
  return names
}
