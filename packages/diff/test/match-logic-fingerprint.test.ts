import { fp, guardedBody, makeSymbol, rule, sig, zeroFp } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { matchStageLogicFingerprint, matchStageNameSignature } from "../src"
import { bare, changesBetween, guarded } from "./helpers"

const SHARED_LOGIC = "111111111111"

/** A method on the one logic every method here shares, which names a guard. */
const withLogic = (file: string, name: string) => guarded(file, name, SHARED_LOGIC)

function stage3(base: readonly IRSymbol[], head: readonly IRSymbol[]) {
  const result = matchStageLogicFingerprint(base, head)
  return {
    pairs: result.matched.map((pair) => [pair.base.id, pair.head.id, pair.rationale]),
    remainingBase: result.remainingBase.map((symbol) => symbol.id),
    remainingHead: result.remainingHead.map((symbol) => symbol.id),
  }
}

describe("matchStageLogicFingerprint", () => {
  it("skips dropped Symbols, whose zeroed fingerprints would all collide", () => {
    const base = makeSymbol({
      id: "ts:a.ts#DtoA",
      name: "DtoA",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const head = makeSymbol({
      id: "ts:a.ts#DtoB",
      name: "DtoB",
      dropped: true,
      fingerprint: zeroFp(),
    })
    expect(stage3([base], [head]).pairs).toEqual([])
  })

  it("pairs a lone base with a lone head however unlike their names are", () => {
    expect(
      stage3([withLogic("src/a.ts", "Svc.alpha")], [withLogic("src/b.ts", "Other.omega")]),
    ).toEqual({
      pairs: [["ts:src/a.ts#Svc.alpha", "ts:src/b.ts#Other.omega", "logic-fingerprint"]],
      remainingBase: [],
      remainingHead: [],
    })
  })

  it("lets names decide between several bases", () => {
    const winner = withLogic("src/a.ts", "Cls.readUser")
    const loser = withLogic("src/a.ts", "Cls.somethingElse")
    expect(stage3([winner, loser], [withLogic("src/b.ts", "Cls.readUser")])).toEqual({
      pairs: [[winner.id, "ts:src/b.ts#Cls.readUser", "logic-fingerprint+name-disambiguation"]],
      remainingBase: [loser.id],
      remainingHead: [],
    })
  })

  it("leaves a group whose names cannot reach 0.85 whole for later stages", () => {
    const body = (file: string, name: string) =>
      makeSymbol({
        id: `ts:${file}#${name}`,
        name,
        kind: "class",
        fingerprint: { api: "aaaaaaaaaaaa", logic: "222222222222", syntax: "bbbbbbbbbbbb" },
        rules: guardedBody("222222222222"),
      })
    expect(
      stage3([body("src/a.ts", "Alpha"), body("src/b.ts", "Beta")], [body("src/c.ts", "Gamma")])
        .pairs,
    ).toEqual([])
  })

  it("pairs the base a scored round leaves alone unconditionally", () => {
    expect(
      changesBetween(
        [withLogic("src/a.ts", "Svc.createOrder"), withLogic("src/b.ts", "Svc.zzz")],
        [withLogic("src/c.ts", "Svc.createOrder"), withLogic("src/d.ts", "Svc.qqq")],
      ),
    ).toEqual([
      "moved ts:src/a.ts#Svc.createOrder -> ts:src/c.ts#Svc.createOrder",
      "moved ts:src/b.ts#Svc.zzz -> ts:src/d.ts#Svc.qqq",
    ])
  })

  it.each([
    [
      "one base is the closer name",
      [withLogic("src/zzz.ts", "Svc.createOrder"), withLogic("src/aaa.ts", "Svc.deleteInvoice")],
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [
        "moved ts:src/zzz.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
        "removed ts:src/aaa.ts#Svc.deleteInvoice",
      ],
    ],
    [
      "two bases tie, settling on the lower base id",
      [withLogic("src/aaa.ts", "Svc.createOrder"), withLogic("src/zzz.ts", "Svc.createOrder")],
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [
        "moved ts:src/aaa.ts#Svc.createOrder -> ts:src/mid.ts#Svc.createOrder",
        "removed ts:src/zzz.ts#Svc.createOrder",
      ],
    ],
    [
      "a lone base has one closer head",
      [withLogic("src/a.ts", "Svc.createOrder")],
      [withLogic("src/b.ts", "Svc.createOrder"), withLogic("src/c.ts", "Other.omega")],
      [
        "added ts:src/c.ts#Other.omega",
        "moved ts:src/a.ts#Svc.createOrder -> ts:src/b.ts#Svc.createOrder",
      ],
    ],
    [
      "a lone base has two heads that tie, settling on the lower head id",
      [withLogic("src/mid.ts", "Svc.createOrder")],
      [withLogic("src/aaa.ts", "Svc.createOrder"), withLogic("src/zzz.ts", "Svc.createOrder")],
      [
        "added ts:src/zzz.ts#Svc.createOrder",
        "moved ts:src/mid.ts#Svc.createOrder -> ts:src/aaa.ts#Svc.createOrder",
      ],
    ],
  ])("answers the same whichever way the arrays are written when %s", (_, base, head, expected) => {
    expect(changesBetween(base, head)).toEqual(expected)
    expect(changesBetween([...base].reverse(), [...head].reverse())).toEqual(expected)
  })
})

describe("matchStageLogicFingerprint over a logic fingerprint that names nothing", () => {
  it.each([
    ["an unrelated class", bare("src/invoice.ts", "InvoiceRenderer")],
    ["an unrelated function", bare("src/invoice.ts", "renderInvoiceTotal", "function")],
  ])("does not pair a lone deleted function with %s", (_, head) => {
    const base = bare("src/mail.ts", "sendWelcomeEmail", "function")
    expect(stage3([base], [head])).toEqual({
      pairs: [],
      remainingBase: [base.id],
      remainingHead: [head.id],
    })
  })

  it.each([
    ["one `for` loop", rule({ type: "loop", loopKind: "for" })],
    ["one `try`", rule({ type: "try" })],
  ])("treats a body of only %s as naming nothing", (_, shape) => {
    const base = bare("src/mail.ts", "sendAllEmails", "function", [shape])
    const head = bare("src/invoice.ts", "renderInvoiceRows", "function", [shape])
    expect(base.fingerprint.logic).toBe(head.fingerprint.logic)
    expect(stage3([base], [head]).pairs).toEqual([])
  })

  it("leaves two unrelated top-level `main`s apart", () => {
    expect(
      stage3(
        [bare("src/tool-a.ts", "main", "function")],
        [bare("src/tool-b.ts", "main", "function")],
      ).pairs,
    ).toEqual([])
  })

  it("pairs a class whose name says two words when it moves file", () => {
    const base = bare("src/old.ts", "InvoiceRenderer")
    const head = bare("src/new.ts", "InvoiceRenderer")
    expect(stage3([base], [head]).pairs).toEqual([
      [base.id, head.id, "logic-fingerprint+name-disambiguation"],
    ])
  })

  it("leaves a class whose name says one word apart, while its method pairs", () => {
    const oldMethod = bare("src/old.ts", "Invoice.render", "method")
    const newMethod = bare("src/new.ts", "Invoice.render", "method")
    expect(
      stage3(
        [bare("src/old.ts", "Invoice"), oldMethod],
        [bare("src/new.ts", "Invoice"), newMethod],
      ),
    ).toEqual({
      pairs: [[oldMethod.id, newMethod.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: ["ts:src/old.ts#Invoice"],
      remainingHead: ["ts:src/new.ts#Invoice"],
    })
  })

  it("keeps a function and a class of one admissible name apart on their kind alone", () => {
    expect(
      stage3(
        [bare("src/a.ts", "InvoiceRenderer", "function")],
        [bare("src/b.ts", "InvoiceRenderer")],
      ).pairs,
    ).toEqual([])
  })

  it("holds the 0.85 bar: 6/7 of a name pairs, 5/6 does not", () => {
    const base = bare("src/a.ts", "fetchUserAccountBillingInvoiceTotal", "function")
    const longer = bare("src/b.ts", "fetchUserAccountBillingInvoiceTotalAmount", "function")
    expect(stage3([base], [longer]).pairs).toEqual([
      [base.id, longer.id, "logic-fingerprint+name-disambiguation"],
    ])
    expect(
      stage3([base], [bare("src/b.ts", "fetchUserAccountBillingInvoice", "function")]).pairs,
    ).toEqual([])
  })

  it("refuses a pair below the bar whether or not its base was the last one left", () => {
    const moved = bare("src/a.ts", "parseAmount", "function")
    const renamed = bare("src/b.ts", "parseAmountValue", "function")
    expect(stage3([moved], [renamed]).pairs).toEqual([])
    expect(
      stage3([moved, bare("src/audit.ts", "flushAuditLog", "function")], [renamed]).pairs,
    ).toEqual([])
  })

  it("does not fall back to pairing a lone base after a scored round", () => {
    const before = bare("src/a.ts", "createOrderEntry", "function")
    const after = bare("src/b.ts", "createOrderEntry", "function")
    expect(
      stage3(
        [before, bare("src/mail.ts", "sendWelcomeEmail", "function")],
        [after, bare("src/invoice.ts", "renderInvoiceTotal", "function")],
      ),
    ).toEqual({
      pairs: [[before.id, after.id, "logic-fingerprint+name-disambiguation"]],
      remainingBase: ["ts:src/mail.ts#sendWelcomeEmail"],
      remainingHead: ["ts:src/invoice.ts#renderInvoiceTotal"],
    })
  })

  it("leaves a renamed call-only method to stage 4, which refuses it too", () => {
    const base = makeSymbol({ ...bare("src/a.ts", "Cls.getUser", "method"), signature: sig() })
    const head = makeSymbol({ ...bare("src/a.ts", "Cls.fetchUser", "method"), signature: sig() })
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead, { paired: [] })
        .matched,
    ).toEqual([])
  })
})

describe("matchStageLogicFingerprint across kinds", () => {
  const body = (id: string, kind: IRSymbol["kind"], over: Partial<IRSymbol> = {}) =>
    makeSymbol({
      id,
      name: id.slice(id.indexOf("#") + 1),
      kind,
      fingerprint: fp("shared"),
      rules: guardedBody("total > 0"),
      ...over,
    })

  it("never pairs across kinds, even on a fingerprint that names something", () => {
    expect(
      matchStageLogicFingerprint([body("ts:a.ts#Foo", "function")], [body("ts:b.ts#Foo", "class")])
        .matched,
    ).toEqual([])
  })

  it.each([
    [
      "a method extracted into a function",
      body("ts:src/a.ts#Cart.computeTotal", "method", { signature: sig() }),
      body("ts:src/b.ts#computeTotal", "function", { signature: sig() }),
    ],
    [
      "an enum rewritten as a `const` in another file",
      makeSymbol({ id: "ts:src/a.ts#OrderStatus", name: "OrderStatus", kind: "enum" }),
      makeSymbol({ id: "ts:src/b.ts#OrderStatus", name: "OrderStatus", kind: "const" }),
    ],
  ])("gives up %s, which stage 4 does not take either", (_, base, head) => {
    const afterStage3 = matchStageLogicFingerprint([base], [head])
    expect(afterStage3.matched).toEqual([])
    expect(
      matchStageNameSignature(afterStage3.remainingBase, afterStage3.remainingHead, { paired: [] })
        .matched,
    ).toEqual([])
  })
})
