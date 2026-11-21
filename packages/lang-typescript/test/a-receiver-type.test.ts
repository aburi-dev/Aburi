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
      classOf("  events: EventEmitter2 | null = null", '  m() { this.events.emit("a") }'),
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
    ["a parameter", "export function f(events: EventEmitter2) { events.emit() }", "f"],
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
