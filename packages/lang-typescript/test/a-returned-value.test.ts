import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

const F = "ts:src/a.ts#f"
const M = "ts:src/a.ts#B.m"
const CREATE = "ts:src/a.ts#B::create"

describe("a function names what a call of it gives back", () => {
  it.each([
    [
      "an annotated class",
      "export function f(): Manager { return make() }",
      F,
      { type: "Manager" },
    ],
    [
      "an annotation that may be `null`",
      "export function f(): Manager | null { return null }",
      F,
      { type: "Manager" },
    ],
    [
      "a namespace's generic class",
      "export function f(): ns.Box<number> { return make() }",
      F,
      { type: "ns.Box" },
    ],
    [
      "`this`, in an instance member",
      "export class B {\n  m(): this { return this }\n}",
      M,
      { self: true },
    ],
    [
      "`this` that may be `null`, in an instance member",
      "export class B {\n  m(): this | null { return null }\n}",
      M,
      { self: true },
    ],
    [
      "`return this`, in an instance member, on every path",
      "export class B {\n  m() {\n    if (a) return this\n    return this\n  }\n}",
      M,
      { self: true },
    ],
    [
      "the class every `return` constructs, a bare one aside",
      "export class B {}\nexport function f() {\n  if (a) return\n  if (b) return null\n  return new B()\n}",
      F,
      { type: "B" },
    ],
    [
      "the class's own name, constructed in its body",
      "export class B {\n  static create() { return new B() }\n}",
      CREATE,
      { type: "B" },
    ],
    [
      "a static field's arrow",
      "export class B {\n  static create = (): B => new B()\n}",
      CREATE,
      { type: "B" },
    ],
    [
      "the one call an arrow's body is",
      "export const f = () => B.create()",
      F,
      { call: { target: "B.create", line: 1 } },
    ],
    [
      "the one call its body returns",
      "export class B {\n  m() {\n    return this.with(1)\n  }\n}",
      M,
      { call: { target: "this.with", line: 3 } },
    ],
    [
      "a name its declaration types",
      "export function f(b: Manager) {\n  return b\n}",
      F,
      { type: "Manager" },
    ],
    [
      "a `const` a call initializes",
      "export function f() {\n  const b = make()\n  return b\n}",
      F,
      { call: { target: "make", line: 2 } },
    ],
    [
      "overloads that all name one type",
      "export function f(a: string): Manager\nexport function f(a: number): Manager\nexport function f(a: unknown) { return make(a) }",
      F,
      { type: "Manager" },
    ],
    [
      "a method's overloads that all name one type",
      "export class B {\n  m(a: string): Manager\n  m(a: number): Manager\n  m(a: unknown) { return make(a) }\n}",
      M,
      { type: "Manager" },
    ],
  ])("for %s", async (_label, source, id, returns) => {
    expect((await symbolOf(source, id)).returns).toEqual(returns)
  })

  it.each([
    ["an `async` function", "export async function f() { return new Manager() }", F],
    ["a generator method", "export class B {\n  *m() { return this }\n}", M],
    ["a generator function", "export function* f() { return new Manager() }", F],
    ["a getter", "export class B {\n  get m() { return new B() }\n}", M],
    ["a setter", "export class B {\n  set m(v: B) { return new B() }\n}", M],
    [
      "`this` on one path and a class on another",
      "export class B {\n  m() {\n    if (a) return this\n    return new B()\n  }\n}",
      M,
    ],
    [
      "a `return` only a callback, a function or a class in the body writes",
      "export function f() {\n  list.map(() => { return new B() })\n  function g() { return new B() }\n  class C { m() { return new B() } }\n}",
      F,
    ],
    [
      "two classes",
      "export class B {}\nexport class C {}\nexport function f() {\n  if (a) return new B()\n  return new C()\n}",
      F,
    ],
    ["two calls", "export function f() {\n  if (a) return g()\n  return h()\n}", F],
    ["a value that is neither", "export function f() { return a ? new B() : new C() }", F],
    ["`this` in a static member", "export class B {\n  static create() { return this }\n}", CREATE],
    [
      "`this` in an object literal's method",
      "export const o = {\n  f() { return this }\n}",
      "ts:src/a.ts#o.f",
    ],
    ["a type parameter", "export function f<T>(): T { return make() }", F],
    ["a class's type parameter", "export class B<T> {\n  m(): T { return make() }\n}", M],
    [
      "a method's overloads that name two types",
      "export class B {\n  m(a: string): Manager\n  m(a: number): Other\n  m(a: unknown) { return make(a) }\n}",
      M,
    ],
    [
      "overloads that name two types",
      "export function f(a: string): Manager\nexport function f(a: number): Other\nexport function f(a: unknown) { return make(a) }",
      F,
    ],
    ["a body that returns nothing", "export function f() { make() }", F],
    ["a `let` a call initializes", "export function f() {\n  let b = make()\n  return b\n}", F],
    [
      "a class a scope between the `return` and the module declares",
      "export function f() {\n  class B {}\n  return new B()\n}",
      F,
    ],
  ])("is absent for %s", async (_label, source, id) => {
    expect(await symbolOf(source, id)).not.toHaveProperty("returns")
  })
})

describe("a variable holding a function names it", () => {
  it.each([
    ["a member of a class", "export const create = B.create", "B.create"],
    ["a name the module binds", "export const create = make", "make"],
    ["a name nothing declares", "export const create = console.log", "console.log"],
  ])("for %s", async (_label, source, reference) => {
    expect((await symbolOf(source, "ts:src/a.ts#create")).returns).toEqual({ reference })
  })

  it.each([
    ["a `let`, which can be assigned another", "export let create = B.create"],
    ["an annotated `const`", "export const create: Factory = B.create"],
    ["a call's result", "export const create = make()"],
  ])("is absent for %s", async (_label, source) => {
    expect(await symbolOf(source, "ts:src/a.ts#create")).not.toHaveProperty("returns")
  })

  it("is absent for a name a namespace declares", async () => {
    const source = "export namespace N {\n  const make = () => 1\n  export const create = make\n}"
    expect(await symbolOf(source, "ts:src/a.ts#N.create")).not.toHaveProperty("returns")
  })
})
