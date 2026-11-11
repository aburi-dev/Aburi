import { changeLines, dependency, fp, makeIR, makeSymbol, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffSchemaViolations } from "./diff-schema"
import {
  bare,
  diffOf,
  diffSymbols,
  guarded,
  method,
  PRINT,
  RENDER,
  type Revision,
  UNSETTLED_OWNERS,
} from "./helpers"

/** Each change with the rationale and the member count it was paired on. */
function pairings(changes: readonly SymbolChange[]): string[] {
  return changes.map((change) => {
    if (!("rationale" in change)) return changeLines([change]).join("")
    const through = change.throughMembers === undefined ? "" : ` x${change.throughMembers}`
    return `${changeLines([change]).join("")} (${change.rationale}${through})`
  })
}

describe("an owner no stage pairs by name, paired on its members", () => {
  it("pairs a class whose name says one word with the class its method moved into", () => {
    const diff = diffSymbols(
      [bare("src/old.ts", "Invoice"), bare("src/old.ts", "Invoice.render", "method")],
      [bare("src/new.ts", "Invoice"), bare("src/new.ts", "Invoice.render", "method")],
    )

    expect(pairings(diff.symbols)).toEqual([
      "moved ts:src/old.ts#Invoice -> ts:src/new.ts#Invoice (name-signature x1)",
      "moved ts:src/old.ts#Invoice.render -> ts:src/new.ts#Invoice.render (logic-fingerprint+name-disambiguation)",
    ])
    expect(diff.summary).toMatchObject({ moved: 2, added: 0, removed: 0 })
  })

  it("pairs a class renamed in place by inflection, counting each method that came with it", () => {
    const members = ["getUser", "findById", "save"]
    const diff = diffSymbols(
      [
        bare("src/repo.ts", "UserRepo"),
        ...members.map((m) => method("src/repo.ts", `UserRepo.${m}`, `a${m}`)),
      ],
      [
        bare("src/repo.ts", "UsersRepo"),
        ...members.map((m) => method("src/repo.ts", `UsersRepo.${m}`, `b${m}`)),
      ],
    )

    expect(pairings(diff.symbols).filter((line) => line.includes("#UserRepo "))).toEqual([
      "moved ts:src/repo.ts#UserRepo -> ts:src/repo.ts#UsersRepo (name-signature x3)",
    ])
    expect(diff.summary).toMatchObject({ moved: 1, movedChanged: 3, added: 0, removed: 0 })
  })

  it("counts the member pairs alone, not a method deleted or added beside them", () => {
    const diff = diffSymbols(
      [
        bare("src/old.ts", "Invoice"),
        guarded("src/old.ts", "Invoice.render", RENDER),
        guarded("src/old.ts", "Invoice.print", PRINT),
      ],
      [
        bare("src/new.ts", "Invoice"),
        guarded("src/new.ts", "Invoice.render", RENDER),
        guarded("src/new.ts", "Invoice.format", "aaaaaaaaaaa3"),
      ],
    )

    expect(pairings(diff.symbols)).toEqual([
      "added ts:src/new.ts#Invoice.format",
      "moved ts:src/old.ts#Invoice -> ts:src/new.ts#Invoice (name-signature x1)",
      "moved ts:src/old.ts#Invoice.render -> ts:src/new.ts#Invoice.render (logic-fingerprint)",
      "removed ts:src/old.ts#Invoice.print",
    ])
  })

  it("settles a nested owner first, and pairs the namespace holding it on that pair", () => {
    const base = [
      bare("src/old.ts", "Billing", "namespace"),
      bare("src/old.ts", "Billing.Invoice"),
      method("src/old.ts", "Billing.Invoice.render", "a"),
    ]
    const head = [
      bare("src/new.ts", "Billing", "namespace"),
      bare("src/new.ts", "Billing.Invoices"),
      method("src/new.ts", "Billing.Invoices.render", "b"),
    ]

    const expected = [
      "moved ts:src/old.ts#Billing -> ts:src/new.ts#Billing (name-signature x1)",
      "moved ts:src/old.ts#Billing.Invoice -> ts:src/new.ts#Billing.Invoices (name-signature x1)",
      "moved+changed ts:src/old.ts#Billing.Invoice.render -> ts:src/new.ts#Billing.Invoices.render (name-signature)",
    ]
    expect(pairings(diffSymbols(base, head).symbols)).toEqual(expected)
    expect(pairings(diffSymbols(base.toReversed(), head.toReversed()).symbols)).toEqual(expected)
  })

  it("reads a member through an object literal that has no Symbol of its own", () => {
    const diff = diffSymbols(
      [bare("src/old.ts", "api", "const"), method("src/old.ts", "api.v1.get", "a")],
      [bare("src/new.ts", "api", "const"), method("src/new.ts", "api.v1.get", "a")],
    )

    expect(pairings(diff.symbols)).toEqual([
      "moved ts:src/old.ts#api -> ts:src/new.ts#api (name-signature x1)",
      "moved ts:src/old.ts#api.v1.get -> ts:src/new.ts#api.v1.get (logic-fingerprint+name-disambiguation)",
    ])
  })

  it("keeps an edge into the class it paired out of the dependency changes", () => {
    const user = makeSymbol({ id: "ts:src/app.ts#main", name: "main", signature: sig() })
    const diff = diffOf(
      makeIR({
        symbols: [
          user,
          bare("src/old.ts", "Invoice"),
          bare("src/old.ts", "Invoice.render", "method"),
        ],
        dependencies: [dependency({ from: user.id, to: "ts:src/old.ts#Invoice" })],
      }),
      makeIR({
        symbols: [
          user,
          bare("src/new.ts", "Invoice"),
          bare("src/new.ts", "Invoice.render", "method"),
        ],
        dependencies: [dependency({ from: user.id, to: "ts:src/new.ts#Invoice" })],
      }),
    )

    expect(diff.dependencies).toEqual({ added: [], removed: [], unknown: [] })
  })

  it.each<[string, IRSymbol]>([
    ["moved", bare("src/new.ts", "Invoice")],
    ["moved+changed", { ...bare("src/new.ts", "Invoice"), fingerprint: fp("edited") }],
  ])(
    "writes a %s owner that validates against aburi.diff.v1, the member count included",
    (status, owner) => {
      const diff = diffSymbols(
        [bare("src/old.ts", "Invoice"), guarded("src/old.ts", "Invoice.render", RENDER)],
        [owner, guarded("src/new.ts", "Invoice.render", RENDER)],
      )

      expect(diff.symbols).toContainEqual(expect.objectContaining({ status, throughMembers: 1 }))
      expect(diffSchemaViolations(diff)).toEqual([])
    },
  )
})

describe("an owner whose members do not all say where it went", () => {
  it.each<[string, Revision, string[]]>([
    [
      "its methods paired into two classes",
      UNSETTLED_OWNERS.split,
      [
        "added ts:src/new.ts#Invoice",
        "added ts:src/new.ts#Printer",
        "removed ts:src/old.ts#Invoice",
      ],
    ],
    [
      "its function moved to the top level",
      UNSETTLED_OWNERS.hoisted,
      ["added ts:src/new.ts#Billing", "removed ts:src/old.ts#Billing"],
    ],
    [
      "the class its method went to has a name that does not correspond",
      UNSETTLED_OWNERS.renamed,
      ["added ts:src/new.ts#Receipt", "removed ts:src/old.ts#Invoice"],
    ],
    [
      "the class its method went to sits a scope deeper",
      UNSETTLED_OWNERS.nested,
      ["added ts:src/new.ts#Billing::Invoice", "removed ts:src/old.ts#BillingInvoices"],
    ],
    [
      "two classes merged into one",
      UNSETTLED_OWNERS.merged,
      ["added ts:src/c.ts#Invoice", "removed ts:src/a.ts#Invoice", "removed ts:src/b.ts#Invoice"],
    ],
    [
      "the namespace its function went to also took in a top-level one",
      UNSETTLED_OWNERS.joined,
      ["added ts:src/new.ts#Billing", "removed ts:src/old.ts#Billing"],
    ],
    [
      "its kind changed",
      {
        base: [bare("src/old.ts", "api", "variable"), method("src/old.ts", "api.get", "a")],
        head: [bare("src/new.ts", "api", "const"), method("src/new.ts", "api.get", "a")],
      },
      ["added ts:src/new.ts#api", "removed ts:src/old.ts#api"],
    ],
    [
      "the class its method went to was paired by its id",
      {
        base: [
          bare("src/old.ts", "Invoice"),
          guarded("src/old.ts", "Invoice.render", RENDER),
          bare("src/new.ts", "Invoice"),
        ],
        head: [bare("src/new.ts", "Invoice"), guarded("src/new.ts", "Invoice.render", RENDER)],
      },
      ["removed ts:src/old.ts#Invoice"],
    ],
  ])("leaves it added and removed when %s", (_label, { base, head }, unpaired) => {
    const diff = diffSymbols(base, head)

    expect(
      diff.symbols.filter((change) => !("before" in change)).flatMap((c) => changeLines([c])),
    ).toEqual(unpaired)
    expect(diff.symbols.some((change) => "throughMembers" in change)).toBe(false)
  })

  it.each<[string, Partial<IRSymbol>]>([
    ["is dropped", { dropped: true, dropReason: "size" }],
    ["has a signature, which is stage 4's to score", { signature: sig() }],
  ])("does not pair an owner that %s", (_label, overrides) => {
    const owner = (file: string) => ({ ...bare(file, "Invoice"), ...overrides })
    const diff = diffSymbols(
      [owner("src/old.ts"), bare("src/old.ts", "Invoice.render", "method")],
      [owner("src/new.ts"), bare("src/new.ts", "Invoice.render", "method")],
    )

    expect(diff.symbols.some((change) => "throughMembers" in change)).toBe(false)
  })

  it.each(["src/a.ts", "src/0.ts"])(
    "pairs the class its members kept to, not the one a scope deeper, beside it in %s",
    (file) => {
      const diff = diffSymbols(
        [
          bare("src/a.ts", "Billing"),
          method("src/a.ts", "Billing.charge", "a"),
          bare(file, "BillingInvoices"),
          method(file, "BillingInvoices.run", "r"),
        ],
        [
          bare("src/b.ts", "Billing"),
          method("src/b.ts", "Billing.charge", "a"),
          bare("src/b.ts", "Billing::Invoice"),
          method("src/b.ts", "Billing::Invoice.run", "r"),
        ],
      )

      expect(pairings(diff.symbols).toSorted()).toEqual(
        [
          "added ts:src/b.ts#Billing::Invoice",
          "moved ts:src/a.ts#Billing -> ts:src/b.ts#Billing (name-signature x1)",
          "moved ts:src/a.ts#Billing.charge -> ts:src/b.ts#Billing.charge (logic-fingerprint+name-disambiguation)",
          `moved ts:${file}#BillingInvoices.run -> ts:src/b.ts#Billing::Invoice.run (name-signature)`,
          `removed ts:${file}#BillingInvoices`,
        ].toSorted(),
      )
    },
  )
})
