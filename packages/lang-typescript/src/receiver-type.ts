import type { ThisBinding } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { firstNonCommentChild, hasChildOfType, nameFieldText } from "./ast-helpers"

const THIS_REBINDING_FUNCTIONS: ReadonlySet<string> = new Set([
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
])

const PARAMETER_PROPERTY_MODIFIERS = ["accessibility_modifier", "override_modifier", "readonly"]

const PARAMETER_TYPES: ReadonlySet<string> = new Set(["required_parameter", "optional_parameter"])

interface ThisScope {
  readonly classBody: Node
  readonly isStatic: boolean
  /** A method whose `this` parameter declares what `this` is, which need not be the class. */
  readonly declaresThis: boolean
}

// Only `this` and `this.<field>` are read: the class `this` is a value of is found by walking up,
// where a plain name would need a scope resolver to tell its declaration from what shadows it.
export function receiverTypeOf(callee: Node): string | null {
  if (callee.type !== "member_expression") return null
  const receiver = callee.childForFieldName("object")
  if (receiver?.type === "this") return instanceClassOf(receiver)
  if (receiver?.type !== "member_expression") return null
  if (receiver.childForFieldName("object")?.type !== "this") return null
  const field = receiver.childForFieldName("property")
  if (field === null) return null
  const scope = thisScope(receiver)
  if (scope === null || scope.declaresThis) return null
  const type = declaredType(scope, field.text)
  return type === null || isShadowed(scope.classBody, headOf(type)) ? null : type
}

export function thisBindingAt(node: Node): ThisBinding | null {
  const scope = thisScope(node)
  if (scope === null) return null
  return scope.isStatic ? "class" : "instance"
}

function thisScope(from: Node): ThisScope | null {
  let child = from
  let inParameterDecorator = false
  for (let node = from.parent; node !== null; child = node, node = node.parent) {
    if (THIS_REBINDING_FUNCTIONS.has(node.type)) return null
    if (node.type === "decorator" && PARAMETER_TYPES.has(node.parent?.type ?? "")) {
      inParameterDecorator = true
    }
    if (!bindsThisFor(node, child)) continue
    // A parameter's decorator is evaluated with the class, outside the method its list belongs to.
    if (inParameterDecorator) {
      inParameterDecorator = false
      continue
    }
    const classBody = node.parent
    if (classBody?.type !== "class_body") return null
    const isStatic = node.type === "class_static_block" || hasChildOfType(node, "static")
    return { classBody, isStatic, declaresThis: hasThisParameter(node) }
  }
  return null
}

// In an instance member `this` is a value of the class itself, which a reader binds by its name.
function instanceClassOf(receiver: Node): string | null {
  const scope = thisScope(receiver)
  if (scope === null || scope.isStatic || scope.declaresThis) return null
  const owner = scope.classBody.parent
  if (owner === null || !CLASS_DECLARATIONS.has(owner.type)) return null
  const name = nameFieldText(owner)
  return name === null || isShadowed(scope.classBody, name) ? null : name
}

const CLASS_DECLARATIONS: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
])

function hasThisParameter(member: Node): boolean {
  const parameters = member.childForFieldName("parameters")
  const first = parameters === null ? null : firstNonCommentChild(parameters)
  return first?.childForFieldName("pattern")?.type === "this"
}

// A member's name and decorators are evaluated outside it, with the `this` around the class.
function bindsThisFor(member: Node, child: Node): boolean {
  switch (member.type) {
    case "method_definition":
      return [member.childForFieldName("body"), member.childForFieldName("parameters")].some(
        (part) => part?.id === child.id,
      )
    case "public_field_definition":
      return member.childForFieldName("value")?.id === child.id
    case "class_static_block":
      return true
    default:
      return false
  }
}

function declaredType(scope: ThisScope, name: string): string | null {
  for (const member of scope.classBody.namedChildren) {
    if (member === null) continue
    if (member.type === "public_field_definition") {
      if (member.childForFieldName("name")?.text !== name) continue
      if (hasChildOfType(member, "static") !== scope.isStatic) continue
      return namedType(member)
    }
    if (!scope.isStatic && isConstructor(member)) {
      const property = parameterProperty(member, name)
      if (property !== null) return namedType(property)
    }
  }
  return null
}

// A reader binds the type's name where the module binds it, so a name a scope between the class
// and the module declares is another type there.
function isShadowed(classBody: Node, name: string): boolean {
  for (let node = classBody.parent; node !== null; node = node.parent) {
    const parameters = node.childForFieldName("type_parameters")?.namedChildren ?? []
    if (parameters.some((parameter) => parameter?.childForFieldName("name")?.text === name)) {
      return true
    }
    if (node.type === "class" && nameFieldText(node) === name) return true
    if (!SCOPE_BLOCKS.has(node.type)) continue
    if (node.namedChildren.some((child) => child !== null && declaredTypeName(child) === name)) {
      return true
    }
  }
  return false
}

const SCOPE_BLOCKS: ReadonlySet<string> = new Set(["statement_block", "switch_case"])

const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "internal_module",
  "module",
])

const DECLARATION_WRAPPERS: ReadonlySet<string> = new Set([
  "export_statement",
  "ambient_declaration",
])

function declaredTypeName(statement: Node): string | null {
  const declaration = DECLARATION_WRAPPERS.has(statement.type)
    ? (statement.childForFieldName("declaration") ?? firstNonCommentChild(statement))
    : statement
  if (declaration === null) return null
  if (declaration.type === "import_alias") return firstNonCommentChild(declaration)?.text ?? null
  if (!TYPE_DECLARATIONS.has(declaration.type)) return null
  const name = dottedName(declaration.childForFieldName("name"))
  return name === null ? null : headOf(name)
}

function headOf(dotted: string): string {
  const dot = dotted.indexOf(".")
  return dot < 0 ? dotted : dotted.slice(0, dot)
}

function isConstructor(member: Node): boolean {
  return (
    member.type === "method_definition" &&
    member.childForFieldName("name")?.text === "constructor" &&
    !hasChildOfType(member, "static")
  )
}

function parameterProperty(construction: Node, name: string): Node | null {
  const parameters = construction.childForFieldName("parameters")?.namedChildren ?? []
  for (const parameter of parameters) {
    if (parameter === null) continue
    if (parameter.childForFieldName("pattern")?.text !== name) continue
    const isProperty = PARAMETER_PROPERTY_MODIFIERS.some((modifier) =>
      hasChildOfType(parameter, modifier),
    )
    return isProperty ? parameter : null
  }
  return null
}

function namedType(declaration: Node): string | null {
  const annotation = declaration.childForFieldName("type")
  const type = annotation === null ? null : firstNonCommentChild(annotation)
  return type === null ? null : typeName(type)
}

function typeName(type: Node): string | null {
  if (type.type !== "generic_type") return dottedName(type)
  const name = type.childForFieldName("name")
  return name === null ? null : typeName(name)
}

const NAME_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
])

const DOTTED_NAME_FIELDS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["nested_identifier", ["object", "property"]],
  ["nested_type_identifier", ["module", "name"]],
])

// Read off the name's parts rather than its text, which keeps the spaces and comments around a `.`.
function dottedName(node: Node | null): string | null {
  if (node === null) return null
  if (NAME_TYPES.has(node.type)) return node.text
  const fields = DOTTED_NAME_FIELDS.get(node.type)
  if (fields === undefined) return null
  const [qualifier, name] = fields.map((field) => dottedName(node.childForFieldName(field)))
  return qualifier == null || name == null ? null : `${qualifier}.${name}`
}
