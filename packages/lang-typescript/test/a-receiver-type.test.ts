import { describe, expect, it } from "vitest"
import { classOf, walkOf } from "./fixtures/ctx"

async function receiverTypeOfCall(
  source: string,
  id: string,
  matches: (target: string) => boolean,
): Promise<string | undefined> {
  const calls = (await walkOf(source, `ts:src/a.ts#${id}`)).calls.filter((c) => matches(c.target))
  expect(calls).toHaveLength(1)
  return calls[0]?.receiverType
}

const emitReceiverType = (source: string, id: string): Promise<string | undefined> =>
  receiverTypeOfCall(source, id, (target) => target.endsWith(".emit"))

const thisReceiverType = (source: string, id: string): Promise<string | undefined> =>
  receiverTypeOfCall(source, id, (target) => target === "this.n")

describe("a call through a field of `this` carries the type the class declares the field with", () => {
  it.each([
    [
      "a constructor parameter property",
      classOf(
        "  constructor(private readonly events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter property beside others",
      classOf(
        "  constructor(private readonly prisma: PrismaClient, private readonly events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter property marked only `readonly`",
      classOf(
        "  constructor(readonly events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter property marked only `override`",
      [
        "export class C extends Base {",
        "  constructor(override events: EventEmitter2) { super() }",
        '  m() { this.events.emit("a") }',
        "}",
      ].join("\n"),
      "C.m",
      "EventEmitter2",
    ],
    [
      "an optional parameter property behind a decorator",
      classOf(
        "  constructor(@Optional() private readonly events?: EventEmitter2) {}",
        '  m() { this.events?.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a typed field",
      classOf("  private events: EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a field declared after a constructor parameter of its name that is not a property",
      classOf(
        "  constructor(events: EventEmitter2) { this.events = events }",
        "  private events: Bus",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "Bus",
    ],
    [
      "a `#`-private field",
      classOf("  #events: EventEmitter2", '  m() { this.#events.emit("a") }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a static field, from a static method",
      classOf("  static events: EventEmitter2", '  static m() { this.events.emit("a") }'),
      "C::m",
      "EventEmitter2",
    ],
    [
      "a static field, from the class's static block, which the class walks",
      classOf("  static events: EventEmitter2", '  static { this.events.emit("a") }'),
      "C",
      "EventEmitter2",
    ],
    [
      "a type written through a namespace",
      classOf("  events: ee.EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
      "ee.EventEmitter2",
    ],
    [
      "a namespaced type spelled with a space and a comment around the dot",
      classOf("  events: ee . /* c */ EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
      "ee.EventEmitter2",
    ],
    [
      "a generic type, without its arguments",
      classOf("  events: Emitter<Payload>", '  m() { this.events.emit("a") }'),
      "C.m",
      "Emitter",
    ],
    [
      "a type that may be null or undefined",
      classOf(
        "  events: EventEmitter2 | null | undefined = null",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a getter",
      classOf("  events: EventEmitter2", '  get g() { return this.events.emit("a") }'),
      "C.g",
      "EventEmitter2",
    ],
    [
      "a setter",
      classOf("  events: EventEmitter2", "  set s(v: string) { this.events.emit(v) }"),
      "C.s",
      "EventEmitter2",
    ],
    [
      "a generator method",
      classOf("  events: EventEmitter2", '  *m() { this.events.emit("a") }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "an arrow inside the method, which keeps its `this`",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return () => this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a field holding an arrow",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m = () => this.events.emit("a")',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter default",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m(sent = this.events.emit("a")) { return sent }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a class nested in the method, whose own field it is",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return class { events!: Bus; n() { this.events.emit("a") } } }',
      ),
      "C.m",
      "Bus",
    ],
    [
      "the computed key of a class nested in the method, which the method's `this` evaluates",
      classOf("  events: EventEmitter2", '  m() { return class { [this.events.emit("a")]() {} } }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a member decorator of a class nested in the method",
      classOf(
        "  events: EventEmitter2",
        '  m() { return class { @D(this.events.emit("a")) n() {} } }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter decorator of a class nested in the method",
      classOf(
        "  events: EventEmitter2",
        '  m() { return class { n(@D(this.events.emit("a")) x: string) {} } }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a generic class, whose type parameter names another type",
      [
        "export class C<Payload> {",
        "  constructor(private events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
        "}",
      ].join("\n"),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a class the module declares beside it",
      [
        "export class Bus {}",
        "export class C {",
        "  events!: Bus",
        '  m() { this.events.emit("a") }',
        "}",
      ].join("\n"),
      "C.m",
      "Bus",
    ],
    [
      "a class in a namespace that declares no type of the name",
      [
        "export namespace N {",
        "  export class Bus {}",
        "  export class C {",
        "    constructor(private events: EventEmitter2) {}",
        '    m() { this.events.emit("a") }',
        "  }",
        "}",
      ].join("\n"),
      "N.C.m",
      "EventEmitter2",
    ],
  ])("reads %s", async (_label, source, id, type) => {
    expect(await emitReceiverType(source, id)).toBe(type)
  })
})

describe("a call through `this` carries no type where the class does not declare one", () => {
  it.each([
    [
      "a field with no annotation",
      classOf("  events = new EventEmitter2()", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a type that is not a name",
      classOf("  events: () => EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a union of two types",
      classOf("  events: EventEmitter2 | Bus", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "an instance field, from a static method",
      classOf("  events: EventEmitter2", '  static m() { this.events.emit("a") }'),
      "C::m",
    ],
    [
      "a static field, from an instance method",
      classOf("  static events: EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a field a base class declares",
      'export class C extends Base {\n  m() { this.events.emit("a") }\n}',
      "C.m",
    ],
    [
      "a field a base class declares, beside the parameter properties the class does",
      [
        "export class C extends Base {",
        "  constructor(private readonly prisma: PrismaClient, private readonly events: EventEmitter2) { super() }",
        '  m() { this.socket.emit("a") }',
        "}",
      ].join("\n"),
      "C.m",
    ],
    [
      "a `function` inside the method, which has a `this` of its own",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return function () { this.events.emit("a") } }',
      ),
      "C.m",
    ],
    [
      "a function declared inside the method",
      classOf(
        "  events: EventEmitter2",
        '  m() { function f() { this.events.emit("a") } return f }',
      ),
      "C.m",
    ],
    [
      "a generator function inside the method",
      classOf("  events: EventEmitter2", '  m() { return function* () { this.events.emit("a") } }'),
      "C.m",
    ],
    [
      "an object literal's method inside the method",
      classOf("  events: EventEmitter2", '  m() { return { n() { this.events.emit("a") } } }'),
      "C.m",
    ],
    [
      "a parameter decorator, which the class evaluates outside the method",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m(@D(this.events.emit("a")) x: string) {}',
      ),
      "C",
    ],
    [
      "a computed key, which the class evaluates outside the member",
      classOf("  events: EventEmitter2", '  [this.events.emit("a")]() {}'),
      "C",
    ],
    [
      "a member decorator, which the class evaluates outside the member",
      classOf("  events: EventEmitter2", '  @D(this.events.emit("a")) n() {}'),
      "C",
    ],
    ["a member of a field", classOf("  events: Hub", "  m() { this.events.bus.emit() }"), "C.m"],
    [
      "a method whose `this` parameter declares another type",
      classOf("  events: EventEmitter2", '  m(this: Other) { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a field behind a non-null assertion",
      classOf("  events!: EventEmitter2", '  m() { this.events!.emit("a") }'),
      "C.m",
    ],
    [
      "a type parameter of the class",
      [
        "export class C<Events> {",
        "  constructor(private events: Events) {}",
        '  m() { this.events.emit("a") }',
        "}",
      ].join("\n"),
      "C.m",
    ],
    [
      "a type parameter of the method a class is nested in",
      classOf('  m<Bus>() { return class { events!: Bus; n() { this.events.emit("a") } } }'),
      "C.m",
    ],
    [
      "a type parameter of the function a class is declared in",
      'export function f<Bus>() { return class { events!: Bus; n() { this.events.emit("a") } } }',
      "f",
    ],
    [
      "the name of the class expression itself",
      'export const make = () => class Bus { events!: Bus; n() { this.events.emit("a") } }',
      "make",
    ],
    [
      "a class the enclosing function declares",
      'export function f() { class Bus {} return class { events!: Bus; n() { this.events.emit("a") } } }',
      "f",
    ],
    [
      "a class a `switch` case declares",
      'export function f(k: number) { switch (k) { case 1: class Bus {} return class { events!: Bus; n() { this.events.emit("a") } } } }',
      "f",
    ],
    [
      "a class the enclosing namespace declares",
      [
        "export namespace N {",
        "  export class EventEmitter2 {}",
        "  export class C {",
        "    constructor(private events: EventEmitter2) {}",
        '    m() { this.events.emit("a") }',
        "  }",
        "}",
      ].join("\n"),
      "N.C.m",
    ],
    [
      "a namespace an enclosing one declares, which a dotted type goes through",
      [
        "export namespace N {",
        "  declare namespace ee { class EventEmitter2 {} }",
        "  export class C {",
        "    constructor(private events: ee.EventEmitter2) {}",
        '    m() { this.events.emit("a") }',
        "  }",
        "}",
      ].join("\n"),
      "N.C.m",
    ],
    [
      "an import alias of the enclosing namespace",
      [
        "export namespace N {",
        "  import EventEmitter2 = lib.Bus",
        "  export class C {",
        "    constructor(private events: EventEmitter2) {}",
        '    m() { this.events.emit("a") }',
        "  }",
        "}",
      ].join("\n"),
      "N.C.m",
    ],
  ])("reads nothing from %s", async (_label, source, id) => {
    expect(await emitReceiverType(source, id)).toBeUndefined()
  })
})

describe("a call through a name carries the type the name is declared with", () => {
  // A typed name around the call, which a declaration nearer it must hide.
  const outer = (body: string) => `export function f(events: EventEmitter2) { ${body} }`

  it.each([
    ["a parameter", "export function f(events: EventEmitter2) { events.emit() }", "f"],
    ["an optional parameter", "export function f(events?: EventEmitter2) { events?.emit() }", "f"],
    [
      "a parameter that may be undefined",
      "export function f(events: EventEmitter2 | undefined) { events.emit() }",
      "f",
    ],
    ["an arrow's parameter", "export const f = (events: EventEmitter2) => events.emit()", "f"],
    ["a method's parameter", classOf("  m(events: EventEmitter2) { events.emit() }"), "C.m"],
    [
      "a parameter read in a closure",
      "export function f(events: EventEmitter2) { return () => events.emit() }",
      "f",
    ],
    [
      "an annotated `const`",
      "export function f() { const events: EventEmitter2 = make(); events.emit() }",
      "f",
    ],
    [
      "an annotated `let` assigned later",
      "export function f() { let events: EventEmitter2 | null = null; events = make(); events.emit() }",
      "f",
    ],
    [
      "a `var` a block of the function declares",
      "export function f(on: boolean) { if (on) { var events: EventEmitter2 = make() } events.emit() }",
      "f",
    ],
    [
      "a `const` constructed from the class",
      "export function f() { const events = new EventEmitter2(); events.emit() }",
      "f",
    ],
    [
      "a `const` of the module, read in a function",
      "const events = new EventEmitter2()\nexport function f() { events.emit() }",
      "f",
    ],
    [
      "an ambient `const` of the module",
      "declare const events: EventEmitter2\nexport function f() { events.emit() }",
      "f",
    ],
    [
      "a parameter that shadows a `const` of the module",
      "const events = new Bus()\nexport function f(events: EventEmitter2) { events.emit() }",
      "f",
    ],
    [
      "a `const` a `switch` case declares",
      "export function f(k: number) { switch (k) { case 1: const events = new EventEmitter2(); events.emit() } }",
      "f",
    ],
    [
      "a `const` a `for` loop's head declares",
      "export function f() { for (const events = new EventEmitter2(); go(); ) events.emit() }",
      "f",
    ],
    [
      "a `var` a namespace declares",
      "export namespace N {\n  var events: EventEmitter2\n  export function f() { events.emit() }\n}",
      "N.f",
    ],
    [
      "a `var` a static block declares",
      "export class C {\n  static { var events: EventEmitter2 = make(); events.emit() }\n}",
      "C",
    ],
    [
      "a parameter that shadows the function expression's own name",
      "export const f = function events(events: EventEmitter2) { events.emit() }",
      "f",
    ],
    [
      "a name of the module a parameter's decorator reads, outside the method",
      "const events = new EventEmitter2()\nexport class C {\n  m(@Use(events.emit()) events: Bus) {}\n}",
      "C",
    ],
    [
      "a class constructed through a namespace, type arguments aside",
      "export function f() { const events = new ee.EventEmitter2<Payload>(); events.emit() }",
      "f",
      "ee.EventEmitter2",
    ],
    [
      "a parameter typed through a namespace",
      "export function f(events: ee.EventEmitter2<Payload>) { events.emit() }",
      "f",
      "ee.EventEmitter2",
    ],
  ])("reads %s", async (_label, source, id, type = "EventEmitter2") => {
    expect(await emitReceiverType(source, id)).toBe(type)
  })

  it.each([
    ["a parameter with no annotation", "export function f(events) { events.emit() }"],
    ["an arrow's bare parameter", outer("return [make()].map(events => events.emit())")],
    ["a destructured parameter", "export function f({ events }: Deps) { events.emit() }"],
    ["a rest parameter", "export function f(...events: EventEmitter2[]) { events.emit() }"],
    [
      "a `let` constructed from the class, which can be assigned another value",
      "export function f() { let events = new EventEmitter2(); events.emit() }",
    ],
    [
      "a `var` constructed from the class, which can be assigned another value",
      "export function f() { var events = new EventEmitter2(); events.emit() }",
    ],
    [
      "a `const` holding what a call returns",
      "export function f() { const events = make(); events.emit() }",
    ],
    ["a union of two types", "export function f(events: EventEmitter2 | Bus) { events.emit() }"],
    [
      "a declaration with no type that shadows a typed one",
      outer("{ const events = make(); events.emit() }"),
    ],
    [
      "a name a `var` declares twice",
      "export function f() { var events: EventEmitter2 = make(); var events: EventEmitter2 = make(); events.emit() }",
    ],
    ["an import", 'import { events } from "./events"\nexport function f() { events.emit() }'],
    ["a `for…of` binding", outer("for (const events of all) events.emit()")],
    ["a `catch` binding", outer("try { make() } catch (events) { events.emit() }")],
    ["a `using` declaration", outer("{ using events = open(); events.emit() }")],
    [
      "an `await using` declaration",
      "export async function f(events: EventEmitter2) { { await using events = open(); events.emit() } }",
    ],
    [
      "a `switch` case's untyped `const`",
      outer("switch (k) { case 1: const events = make(); events.emit() }"),
    ],
    ["a `for` loop's untyped head", outer("for (let events = make(); go(); ) events.emit()")],
    ["a function expression's own name", outer("return function events() { events.emit() }")],
    ["a class's own name in its body", outer("return class events { m() { events.emit() } }")],
    [
      "a `var` a nested function declares, which binds it there alone",
      "export function f() { function g() { var events: EventEmitter2 } events.emit() }",
    ],
    ["a global", "export function f() { events.emit() }"],
    [
      "a type parameter of the function",
      "export function f<EventEmitter2>(events: EventEmitter2) { events.emit() }",
    ],
    [
      "a type the block declares beside the variable",
      "export function f() { class EventEmitter2 {} const events: EventEmitter2 = make(); events.emit() }",
    ],
    [
      "a class a parameter around the `new` names, which shadows the class the module binds",
      "export function f(EventEmitter2: any) { const events = new EventEmitter2(); events.emit() }",
    ],
    [
      "a name behind a non-null assertion",
      "export function f(events?: EventEmitter2) { events!.emit() }",
    ],
    ["a member of a name", "export function f(deps: Deps) { deps.events.emit() }"],
  ])("reads nothing from %s", async (_label, source) => {
    expect(await emitReceiverType(source, "f")).toBeUndefined()
  })
})

describe("a call of a member of `this` in an instance member carries the class's own name", () => {
  it.each([
    ["a method", classOf("  m() { this.n() }"), "C.m"],
    ["an arrow inside a method", classOf("  m() { [1].map(() => this.n()) }"), "C.m"],
    ["a field's arrow", classOf("  handle = () => this.n()"), "C.handle"],
    ["a constructor", classOf("  constructor() { this.n() }"), "C.constructor"],
    ["an abstract class's method", "export abstract class C {\n  m() { this.n() }\n}", "C.m"],
    ["a default-exported class's method", "export default class C {\n  m() { this.n() }\n}", "C.m"],
  ])("in %s", async (_label, source, id) => {
    expect(await thisReceiverType(source, id)).toBe("C")
  })

  it.each([
    ["a static member, where `this` is the class", classOf("  static m() { this.n() }"), "C::m"],
    ["a class expression", "export const X = class C {\n  m() { this.n() }\n}", "X.m"],
    ["an anonymous default class", "export default class {\n  m() { this.n() }\n}", "<default>"],
    [
      "a class declared in a function, which a reader binds apart",
      "export function f() {\n  class C {\n    m() { this.n() }\n  }\n}",
      "f",
    ],
    [
      "a class declared in a namespace",
      "export namespace N {\n  export class C {\n    m() { this.n() }\n  }\n}",
      "N.C.m",
    ],
    ["an object literal's method", "export const o = {\n  m() { this.n() },\n}", "o.m"],
    [
      "a method whose `this` parameter declares another type",
      classOf("  m(/* bound */ this: Other, x: number) { [x].map(() => this.n()) }"),
      "C.m",
    ],
    [
      "a `function` inside a method, which binds its own `this`",
      classOf("  m() { return function () { this.n() } }"),
      "C.m",
    ],
  ])("reads nothing from %s", async (_label, source, id) => {
    expect(await thisReceiverType(source, id)).toBeUndefined()
  })
})

describe("a call through `super` carries the name of the class the enclosing class extends", () => {
  const superReceiverType = (source: string, id: string, target: string) =>
    receiverTypeOfCall(source, id, (written) => written === target)
  const extending = (...members: string[]) =>
    ['import { Base } from "./base"', "export class C extends Base {", ...members, "}"].join("\n")

  it.each([
    [
      "a constructor's `super(…)`",
      extending("  constructor() { super(1) }"),
      "C.constructor",
      "super",
    ],
    ["a method's `super.<member>`", extending("  m() { super.n() }"), "C.m", "super.n"],
    ["an arrow inside a method", extending("  m() { [1].map(() => super.n()) }"), "C.m", "super.n"],
    ["a field's arrow", extending("  handle = () => super.n()"), "C.handle", "super.n"],
    [
      "a method whose `this` parameter declares another type, which `super` does not read",
      extending("  m(this: Other) { super.n() }"),
      "C.m",
      "super.n",
    ],
    [
      "a class a binding holds",
      'import { Base } from "./base"\nexport const C = class extends Base {\n  m() { super.n() }\n}',
      "C.m",
      "super.n",
    ],
    [
      "a dotted name the class extends",
      'import * as b from "./base"\nexport class C extends b.Base {\n  m() { super.n() }\n}',
      "C.m",
      "super.n",
    ],
  ])("in %s", async (_label, source, id, target) => {
    const type = source.includes("b.Base") ? "b.Base" : "Base"
    expect(await superReceiverType(source, id, target)).toBe(type)
  })

  it.each([
    ["a static member", extending("  static m() { super.n() }"), "C::m"],
    [
      "a class that extends a call",
      "export class C extends Mixin(Base) {\n  m() { super.n() }\n}",
      "C.m",
    ],
    [
      "a class that extends a name a scope around it binds",
      "export function f(Base: any) {\n  class C extends Base {\n    m() { super.n() }\n  }\n}",
      "f",
    ],
    ["an object literal's method", "export const o = {\n  m() { super.n() },\n}", "o.m"],
  ])("reads nothing from %s", async (_label, source, id) => {
    expect(await superReceiverType(source, id, "super.n")).toBeUndefined()
  })
})
