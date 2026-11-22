import type { ThisBinding } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { firstNonCommentChild, hasChildOfType, nameFieldText } from "./ast-helpers"
import { isParameterProperty } from "./class-members"
import { bindingOf, isModuleBinding, PARAMETER_TYPES } from "./name-binding"

const THIS_REBINDING_FUNCTIONS: ReadonlySet<string> = new Set([
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
])

interface ThisScope {
  readonly classBody: Node
  readonly isStatic: boolean
  /** A method whose `this` parameter declares what `this` is, which need not be the class. */
  readonly declaresThis: boolean
}

export function receiverTypeOf(callee: Node): string | null {
  if (callee.type !== "member_expression") return null
  const receiver = callee.childForFieldName("object")
  if (receiver?.type === "this") return instanceClassOf(receiver)
  if (receiver?.type === "identifier") return nameTypeOf(receiver)
  if (receiver?.type !== "member_expression") return null
  if (receiver.childForFieldName("object")?.type !== "this") return null
  const field = receiver.childForFieldName("property")
  if (field === null) return null
  const scope = thisScope(receiver)
  if (scope === null || scope.declaresThis) return null
  const type = declaredType(scope, field.text)
  return type === null || isShadowed(scope.classBody, headOf(type)) ? null : type
}

// A name is a value of the type its one declaration gives it: a parameter's or a variable's
// annotation, or the class a `const` is constructed from, which it holds for as long as it is bound.
function nameTypeOf(name: Node): string | null {
  const [declaration, ...others] = bindingOf(name, name.text)?.declarations ?? []
  if (declaration === undefined || others.length > 0) return null
  if (declaration.type === "variable_declarator") {
    if (declaration.childForFieldName("name")?.type !== "identifier") return null
    if (declaration.childForFieldName("type") !== null) return annotatedType(declaration)
    return isConst(declaration) ? constructedClass(declaration.childForFieldName("value")) : null
  }
  if (!PARAMETER_TYPES.has(declaration.type)) return null
  if (declaration.childForFieldName("pattern")?.type !== "identifier") return null
  return annotatedType(declaration)
}

function annotatedType(declaration: Node): string | null {
  const type = namedType(declaration)
  return type === null || isShadowed(declaration, headOf(type)) ? null : type
}

function isConst(declarator: Node): boolean {
  const declaration = declarator.parent
  return (
    declaration?.type === "lexical_declaration" &&
    declaration.childForFieldName("kind")?.type === "const"
  )
}

function constructedClass(value: Node | null): string | null {
  if (value?.type !== "new_expression") return null
  return moduleClassName(value.childForFieldName("constructor"))
}

export function superclassOf(classNode: Node): string | null {
  const heritage = classNode.namedChildren.find((child) => child?.type === "class_heritage")
  const clause = heritage?.namedChildren.find((child) => child?.type === "extends_clause")
  return moduleClassName(clause?.childForFieldName("value") ?? null)
}

// `new` and `extends` read a value, so the class is the one the module binds under that name only
// when no scope between the expression and the module binds the name to something else.
function moduleClassName(expression: Node | null): string | null {
  const name = expression === null ? null : dottedName(expression)
  if (expression === null || name === null) return null
  const binding = bindingOf(expression, headOf(name))
  return binding === null || isModuleBinding(binding) ? name : null
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

// A reader binds the type's name where the module binds it, so a name a scope between the
// declaration and the module declares is another type there.
function isShadowed(declaration: Node, name: string): boolean {
  for (let node = declaration.parent; node !== null; node = node.parent) {
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
    return isParameterProperty(parameter) ? parameter : null
  }
  return null
}

function namedType(declaration: Node): string | null {
  const annotation = declaration.childForFieldName("type")
  const type = annotation === null ? null : firstNonCommentChild(annotation)
  return type === null ? null : typeName(withoutNullish(type))
}

// `T | undefined` and `T | null` hold a `T` whenever a member can be called on them.
function withoutNullish(type: Node): Node {
  if (type.type !== "union_type") return type
  const members = unionMembers(type).filter((member) => !isNullish(member))
  return members.length === 1 && members[0] !== undefined ? members[0] : type
}

function unionMembers(type: Node): Node[] {
  return type.namedChildren.flatMap((member) => {
    if (member === null || member.type === "comment") return []
    return member.type === "union_type" ? unionMembers(member) : [member]
  })
}

function isNullish(type: Node): boolean {
  const value = type.type === "literal_type" ? firstNonCommentChild(type) : null
  return value?.type === "null" || value?.type === "undefined"
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
  ["member_expression", ["object", "property"]],
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
