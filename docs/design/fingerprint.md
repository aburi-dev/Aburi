# Fingerprint Computation

Exact computation rules for the three axes — `api` / `logic` / `syntax` — of the `Symbol.fingerprint` emitted by Aburi.
Diff stability is guaranteed only by implementations that follow the conventions in this document.

Reference implementation: [`schema/fingerprint.mjs`](https://github.com/aburi-dev/Aburi/blob/main/schema/fingerprint.mjs)
Invariance tests: [`schema/fingerprint.test.mjs`](https://github.com/aburi-dev/Aburi/blob/main/schema/fingerprint.test.mjs)

---

## 1. Purpose

| Axis | Changes when | Invariant under |
|---|---|---|
| `api` | Public signature / decorators / visibility / exception declarations change | Body implementation changes |
| `logic` | The set of rules / effects changes | Local variable renames, method reordering, comments, added decoration calls |
| `syntax` | AST structure changes | Formatting-only changes, comments |

Separating the three axes lets the Diff report distinguish "API change", "implementation logic change", and "an edit outside what `api` and `logic` read" (§4.6), which is not the same as "no change in behaviour".

## 2. Common Specification

### 2.1 Hash function

- Algorithm: **SHA-256**
- Output: **hex representation of the first 6 bytes** (12 characters, 48 bits)
- Encoding: lowercase hex

48 bits makes the collision probability within a single monorepo practically zero (`2^48 ≈ 2.8 × 10^14`). Fingerprints are also read by humans in diff reports, so the string length is kept short.

### 2.2 String normalization (Canonical String)

Applied to every string that enters a fingerprint input:

1. Unicode NFC normalization
2. Collapse consecutive whitespace (space / tab / newline) into a single space
3. Trim leading and trailing whitespace
4. The empty string stays the empty string

### 2.3 Serialization convention (Canonical JSON)

Hash inputs are serialized as JSON before being fed to SHA-256. Serialization follows:

1. Object keys are sorted in **ascending codepoint order**
2. No separator whitespace (`{"a":1,"b":2}` form)
3. Array element order **follows the rules specified in this document** (default: preserve input order)
4. Numbers follow the JSON standard (no decimal point on integers, `NaN` / `Infinity` not allowed)
5. String escaping follows the JSON standard; characters other than ASCII control characters are emitted as-is (no `\uXXXX` required)
6. A key whose value is absent (`undefined`) is not written at all. `null` is a value and is written, as `extKind`'s is. The parameter keys of §3.1 rely on the first: a parameter with no marker, modifier or decorator serializes to `{"type":…}` alone

Encode as UTF-8, then pass to SHA-256.

## 3. `api` fingerprint

Represents the symbol's **externally observable contract**. Changes when the "public contract" that consumers can depend on changes.

### 3.1 Input fields

```jsonc
{
  "kind": <Symbol.kind>,
  "extKind": <Symbol.extKind>,
  "shortName": <lastSegment(Symbol.name)>,     // see §3.3
  "visibility": <Symbol.visibility>,
  "exportedAs": [<name>],                       // sorted; left out for its own name alone or none, see §3.8
  "decorators": [
    {
      "name": <Decorator.name>,
      "raw": <canonical(Decorator.raw)>,        // includes arguments
      "boundary": <Decorator.boundary>
    }
  ],                                            // all decorators, sorted by (name, line)
  "signature": null | {
    "inputs": [{
      "type": <canonical(input.type)>,
      "optional": true,                         // only when input.optional is true
      "rest": true,                             // only when input.rest is true
      "modifiers": [<input.modifiers[i]>],      // only when non-empty; input order preserved
      "decorators": [<canonical(input.decorators[i])>]  // only when non-empty; sorted (alpha)
    }],                                         // name excluded, input order preserved
    "outputs": [<canonical(output)>],           // input order preserved
    "throws": [<canonical(throw)>],             // sorted (alpha)
    "async": <bool>,
    "generator": <bool>,
    "typeParameters": [<canonical(tp)>]         // input order preserved
  }
}
```

`language` is **not included in the input**. It is already separated by the `<language>:` prefix inside Symbol.id, and by design `language` never changes between Symbols with the same ID. The fingerprint represents only the API surface of a single Symbol.

`optional` and `rest` are what a caller sees of a parameter's form besides its type ([ir-schema.md](./ir-schema.md) §7). Each is written only when `true`, and a `false` written against the Class B rule hashes as absent. `modifiers` and `decorators` are what the parameter is to its class and to a framework: a parameter property's `private` → `public` adds a member callers can read, and `@Inject(A)` → `@Inject(B)` or `@Param("id")` → `@Param("key")` changes what the parameter is handed. Each is written only when it holds an entry, and a `[]` written against the Class B rule hashes as absent. By §2.3 rule 6 an absent key writes nothing, so a parameter with none of the four contributes the same bytes whether or not its Document knows of the fields. A parameter's decorators are sorted, as a Symbol's are: the frameworks that read them keep each decorator's metadata apart, so for either kind a reorder is not a contract change (§3.4), and a parameter's still reaches `syntax` through its parameter list ([lang-plugin.md](./lang-plugin.md) LP8p1). Its modifiers keep source order, which TypeScript fixes (an accessibility modifier, then `override`, then `readonly`), so sorting them would tell nothing apart.

### 3.2 Formula

```
api_input = CanonicalJSON(object above)
api = lower_hex(SHA-256(UTF-8(api_input))[0..6])
```

### 3.3 `shortName` = `lastSegment(Symbol.name)`

`Symbol.name` is a qualified name (`InvoiceService.createInvoice`, `Class::method`, `A.B.C.method`).
Only the **last segment** goes into the api fingerprint:

```
lastSegment(name):
  tail ← part after the last "::" (the whole name if there is none)
  return part of tail after its last "." (the whole tail if there is none)
```

Examples:
- `InvoiceService.createInvoice` → `createInvoice`
- `Class::staticMethod` → `staticMethod`
- `C::Inner.g` → `g`
- `A.B.C.method` → `method`
- `topLevelFunc` → `topLevelFunc`

`<default>` and `<module>` stay as they are.

`@aburi/types` exports this function as `lastSegment`, and every package that needs the short name reads it there: the core for the api fingerprint, the diff's name matchers, and the report when it decides whether a renamed pair's name row explains its API flag. It gives `""` for an empty name, or for one that ends in a separator. The core refuses that result with `anonymous-symbol-id-attempted`, since no Symbol it fingerprints has such a name; the diff and the report read a Document written by someone else and take the empty segment as it is.

### 3.4 Guaranteed invariance conditions

- Changing `signature.inputs[].name` does not change `api` (parameter names are not part of the contract)
- Changing only a default's **value** (`limit = 10` → `limit = 20`) does not change `api`: omitting the argument stays legal either way, so the value is not part of the api contract. The IR records that a default exists (`optional`) and not what it is. What the default runs is read with the body instead ([lang-plugin.md](./lang-plugin.md) LP20d), so a default that calls something reaches `logic`
- Changing local variable names, the function body, or rules/effects does not change `api`. A thrown name is recorded in `throws` only when the name it starts with is bound outside the Symbol, by the module, a namespace, an import, the class around a method or the global scope, so renaming a parameter, a `catch` binding or a local the Symbol throws does not change `api` either ([lang-plugin.md](./lang-plugin.md) LP13b)
- Reordering the **occurrence order** of a Symbol's decorators, or of a parameter's, does not change `api` (both are sorted, §3.1)
- **Changing only the class-scope portion of `Symbol.name` (`InvoiceService.createInvoice` → `BillingService.createInvoice`) does not change `api`** (the last segment is the same)
- Breaking a type over lines, or joining it back onto one line, does not change `api`: `| A | B` ↔ `A | B`, `Array<` … `| A` … `| B` … `>` ↔ `Array<A | B>`, `(` … `a: A,` … `) => void` ↔ `(a: A) => void`, `{` … `a: A` … `b: B` … `}` ↔ `{ a: A; b: B }`. A formatter that breaks a type adds the line breaks, a trailing comma before a closing bracket and a union's leading `|`, drops an object type's `;` between members, and undoes each of these when it joins the type, and it picks the quotes around a string literal type (`'a' | 'b'` ↔ `"a" | "b"`), so the language plugin records each type as it reads on one line, in the spelling a rule's strings take ([lang-plugin.md](./lang-plugin.md) §4.4, LP11e). It is the plugin's to do rather than the fingerprint's: the canonical string sees only text, where telling a union's operator from a `|` inside a string literal type takes the grammar, and the recorded text is also what the diff's delta rows and its rename pairing compare
- Breaking a decorator's arguments over lines, adding a trailing comma to them or a comment inside them, or swapping the quotes around a string in them that needs no escape either way, does not change `api`, for a Symbol's decorators and a parameter's alike: `@Inject(` … `TOKEN,` … `)` ↔ `@Inject(TOKEN)` ↔ `@Inject(/* legacy */ TOKEN)`, `@Controller('users')` ↔ `@Controller("users")`. The language plugin records a decorator's `raw` and `arguments`, and a parameter's decorators, in the spelling a rule's strings take, as it records a type ([lang-plugin.md](./lang-plugin.md) §4.4, LP11f, LP14)
- Exporting a declaration under its own name by an export clause instead of the `export` keyword (`export function f` → `function f` with `export { f }`), or reordering the names a clause exports it under, does not change `api` (§3.8)

### 3.5 Guaranteed change conditions

- `visibility` changes → changes
- A parameter becomes optional or required, gains or loses a default, or becomes or stops being a rest parameter → changes (`signature.inputs[].optional` / `.rest`, [ir-schema.md](./ir-schema.md) §7). A default's value does not (§3.4)
- Any of `signature.inputs[].type` / `outputs` / `throws` changes → changes
- A parameter property's modifier, or a parameter's decorator, is added, removed or changed → changes (`signature.inputs[].modifiers` / `.decorators`). Reordering a parameter's decorators does not (§3.4)
- Adding / removing a decorator or changing its arguments → changes (whether boundary or non-boundary)
- `shortName` change (= renaming the method/function itself) → changes
- `async` / `generator` flag change → changes
- `kind` / `extKind` change → changes
- The names the module exports the declaration under change → changes: a name added to or removed from an export clause (`export { handler as GET }` → `export { handler as GET, handler as DELETE }`), a clause renaming its export (`export { connect as open }` → `export { connect as start }`), a default export made a named one (`export default function Page` → `export function Page`), or an export under the declaration's own name dropped beside an alias (§3.8)

### 3.6 Why decorator arguments are included in api

The URL portion of `@Post('/invoices')` and the Guard of `@UseGuards(RolesGuard)` are part of the external contract. If arguments were excluded from the fingerprint, changing the URL would leave `api` unchanged and go undetected during review.

### 3.7 Design so that class rename does not flag every method as an API change

Renaming a class such as `InvoiceService` → `BillingService` is common implementation work, but the public contract of each method (signature, decorators, return type) is unchanged.
The api fingerprint reads a member's `shortName` (§3.3), not its qualified name, so a method's `api` does not move with its class's name. Whether the diff pairs the rename is [`diff-algorithm.md`](./diff-algorithm.md)'s question: the class itself is not paired by name and signature, since stage 4 skips a Symbol with a null signature (§3.4.3 there), so a rename that changes its words is `added` + `removed` unless its members pair it (§3.4.8); each method pairs by the diff's own stages — on identical logic (§3.3), or by name only where the owner gate accepts the two class names (§3.4.6). A method that pairs is `moved` with `delta.apiChanged: false`, so a rename is never mass-listed in the API changes section (the highest-severity section).

### 3.8 The names a declaration is exported under

An importer reaches a declaration by the name its module exports it under, and that name is not always the one it was declared with: `const handler = NextAuth(options)` with `export { handler as GET, handler as POST }` is the module's `GET` and `POST`, and Next.js serves a request by which of them the module exports. Adding `handler as DELETE` opens an endpoint, and `export { connect as open }` becoming `export { connect as start }` breaks every `import { open }`, while `shortName` and `visibility` stay as they were. The names are part of the contract for §3.6's reason.

They are read from `derivedBy` ([lang-plugin.md](./lang-plugin.md) LP6a–LP6c): `export-keyword` names the Symbol's own `name`, `export-default` names `default`, and `export-clause:<name>` names `<name>`. The input holds each once, sorted, so the order a module writes its clauses in is no contract. The keyword and a clause exporting a declaration under its own name read as one export because both name the Symbol's own name. When the names are that own name alone, or none, `exportedAs` is left out: `visibility` already tells those two apart, and such a Symbol hashes as it would without the names. An anonymous default export is named `<default>` and exported as `default`, which is its own name in that reading. The own name is the whole qname, so a namespace member exported by the keyword, `N.GET`, is exported under its own name and not as the module's `GET`.

## 4. `logic` fingerprint

Represents the **meaning executed by the symbol's body**. Changes when the meaning of the implementation changes.

### 4.1 Input fields

```jsonc
{
  "rules": [
    {
      "type": <Rule.type>,
      "condition": <canonical(Rule.condition)> | null,
      "what": <canonical(Rule.what)> | null,
      "expr": <canonical(Rule.expr)> | null,
      "loopKind": <Rule.loopKind> | null
    }
  ],                                            // input order (= source order = ascending line) preserved
  "effects": [
    {
      "target": <canonical(Effect.target)>
    }
  ],                                            // locally detected effects in input order, then propagated targets (below)
  "middleware": [Symbol.middleware[i]]               // only when Symbol.middleware is present; as the IR holds it; input order preserved
}
```

`middleware` is read only when the Symbol carries it ([`ir-schema.md`](./ir-schema.md) §5.8), and the key is left out of the input otherwise rather than written as `[]`, so every Symbol that names no middleware hashes to the value it had before the field existed. Its order is kept for the reason §4.7 keeps the order of effects: a rate limit in front of authentication and one behind it are two different routes. The names are read as the IR holds them, which the scan already wrote in canonical form ([`ir-schema.md`](./ir-schema.md) §5.8), so the fingerprint and the diff's middleware delta ([`diff-algorithm.md`](./diff-algorithm.md) §5.6) compare the same strings: were the fingerprint to canonicalize them again, `requireRole("a  b")` → `requireRole("a b")` would leave `logic` unmoved while the delta reported one name removed and another added.

The rule strings are the ones the IR holds, already in the ir-schema.md §8.2 form: comments removed, whitespace collapsed, and cut to 120 characters plus `...`. Reading what the IR holds keeps `logic` recomputable from a Document alone. The cost is that an edit past the 120th character of a long condition, throw value or return expression moves neither `logic` nor the diff's rule delta; `syntax` still moves, so the change is reported as syntax-only rather than missed.

`effects` is built in two segments, split on `Effect.propagated`, the one field besides `target` the input reads ([`effect-propagation.md`](./effect-propagation.md) §5.1):

1. **Locally detected effects** (`propagated` absent or `false`), in input order (= call order: ascending `line`, and on one line the order the language plugin wrote the calls in), one entry per effect: a target called twice is two entries.
2. **Propagated effects** (`propagated: true`), after every locally detected one, by `canonical(target)` alone: sorted ascending by UTF-16 code unit, each target once, and leaving out any target segment 1 already holds.

Segment 2 is not read as the IR stores it. The IR orders that segment by `(id, target)` and merges it on that pair ([`effect-propagation.md`](./effect-propagation.md) §5.1, §8), and `id` is not part of the input (below), so reading it as stored would let an id change reorder a caller's targets, repeat one, or leave in place a target the caller's own effects already name. Each moves the `logic` of every transitive caller while the callee's own stays put (§4.5). Propagated entries have no call-site position, and propagation already merges their repeats, so this loses nothing §4.7 protects.

`Effect.id` (e.g. `db.write` / `x-prisma:create`) is **not included in the input**. Reasons:

- `id` is the classification result of an effect plugin; changing the plugin configuration (`config.effects[]`) can give the same call a different id
- If `id` were included, merely reversing the order of `effects: ["effects-prisma", "effects-stripe"]` would change the logic FP of the entire IR, making comparison against past IRs impossible
- "The meaning of an effect on a given target" is sufficiently determined by the target string (`prisma.invoice.create`)
- id is used for display (Markdown projection / diff report classification); target is used as the stability indicator

### 4.2 Formula

```
logic_input = CanonicalJSON(object above)
logic = lower_hex(SHA-256(UTF-8(logic_input))[0..6])
```

### 4.3 Guaranteed invariance conditions

- Reordering the **declaration order** of methods leaves each method's `logic` unchanged (computed per-symbol)
- Renaming a local variable that does **not appear** in the strings of rules/effects leaves `logic` unchanged
- Lengthening, shortening or re-wrapping a run of whitespace, or writing or leaving out a space between two tokens → unchanged. The language plugin writes a rule's strings from the tokens and regenerates the spacing between them ([ir-schema.md](./ir-schema.md) §8.2), so `a||b` and `a || b` are one string. The collapse reaches inside a literal too, so `"a  b"` and `"a b"` are one string, the one case where two programs share a rule's string
- Adding or removing a comment → unchanged. The language plugin leaves comments out of a rule's strings, and the spacing it regenerates does not depend on them, so `a/**/||b` reads `a || b`, as `a||b` does, and `a-/**/-b`, which is `a - (-b)`, reads `a - -b`, never `a--b`
- A spelling a formatter chooses → unchanged: the quotes around a string and the escapes they take, the quotes around a key that needs none, a trailing comma, the `;` that ends a statement, the parentheses around an arrow's lone parameter, `new A` against `new A()`, parentheses the grouping does not need or that spell out mixed operators, a number's letter case and zeros, and JSX's layout, the `{" "}` written where it breaks a line and the parentheses around it. The language plugin writes each one way ([lang-plugin.md](./lang-plugin.md) §4.4, LP19d): a string as its value between `"`, so `'it\'s'` and `"it's"` are one string
- Adding a call classified as decoration (logger / `console.log` / anything dropped at extraction) → unchanged
- Adding / changing decorators → unchanged (decorators belong to the api axis)

### 4.4 Guaranteed change conditions

- Reordering **rules** → changes (control-flow execution order carries meaning). Declared values are rules too, so reordering an object constant's keys or an enum's members changes `logic` as well, a string enum's included: `{ a: 1, b: 2 }` → `{ b: 2, a: 1 }`
- Reordering **locally detected effects** → changes (side-effect occurrence order carries meaning). The order of propagated effects is not read (§4.1)
- Changing the expression of `rules[].condition` / `what` / `expr` itself → changes. That covers the condition of every `if`, a guard's and a branch's alike, a loop's header (`i < n` → `i <= n`), a `case` label, and a declared value: a constant's initializer (`TIMEOUT_MS = 5000` → `5`), an entry of an object a constant holds, and an enum member ([`ir-schema.md`](./ir-schema.md) §8.1). Adding or removing an enum member adds or removes a rule, and so changes `logic` too
- Adding / removing an effect, or changing its `target` → changes, except that a propagated effect on a target another effect of the Symbol already names adds or removes nothing (§4.1)
- Adding, removing, reordering or renaming a Symbol's **middleware** → changes. A route that loses `requireAdmin` runs a different request path, and before the field it moved only `syntax`, so the report filed it as a reformat

### 4.5 Guaranteed invariance conditions (plugin-configuration robustness)

- Even if the `effects[].id` classification of an effect plugin changes (e.g. `db.write` ↔ `x-prisma:create`), `logic` is unchanged as long as the target is the same
- Adding / removing effect plugins or reordering the config does not break the logic stability of the IR
- Time-series comparison against past IRs is robust to plugin configuration changes
- This holds for propagated effects too. The IR orders their segment by `(id, target)` and merges it on that pair ([`effect-propagation.md`](./effect-propagation.md) §5.1, §8), so an id change can reorder its entries, split one target into two entries or merge two into one, and decide whether a locally detected effect on the same target suppresses one. The fingerprint reads the segment by target alone (§4.1): sorted, each target once, and none a locally detected effect already names, so none of this reaches `logic`. Locally detected effects keep their call order and their repeats (§4.7)
- The guarantee is the effect plugins'. A framework plugin's answers are inputs of `logic`: the middleware it reports (§4.1), and the calls its manifest declares never return, which make an `if` around one a guard ([ir-schema.md](./ir-schema.md) §8). Adding or removing `@aburi/framework-next` moves `logic` for a Symbol with `if (!session) redirect("/login")` in it, since the `if` is a guard only when the plugin is loaded

### 4.6 What `logic` does not read

`logic` reads the rules, the effects and the middleware, and nothing else of a body. An edit to any of the following moves `syntax` alone, so the diff files it under Syntax-only changes, with `--fail-on logic-changed` not firing:

- an operator, a ternary or a call argument outside every rule: `total += x` → `total -= x`, `audit(a && b)` → `audit(a || b)`, `const next = ok ? a : b` swapped
- which function a call outside every rule calls: `validate(x)` → `destroy(x)`, where `if (validate(x))` → `if (destroy(x))` changes a rule's condition and moves `logic`. The call graph does read it, so the dependency section reports the edge that went and the one that came, and an effect classified from either call moves `logic` through `effects`
- an `await` added or removed, and an assignment, outside every rule: `if (await ok())`, `for await` and a loop header's `i++` → `i += 2` are a rule's text
- a `break` removed so that a `case` falls through to the next one. The labels are rules; where control goes after one is not
- a trivial return (`return true` → `return false`), which is not a rule ([`ir-schema.md`](./ir-schema.md) §8.2)
- a rule inside a `catch` clause (ir-schema.md §8.2), a class field's value (`static RETRIES = 3`), and a local constant (`const limit = 10` inside a function)
- a constant whose value holds a call, a `new` or an `await` anywhere (`createClient({ retries: 3 })`, `readPort() ?? 8080`): what a call is handed is not an input, in a constant as in any body

The report's Syntax-only section therefore says the edit landed outside the API, rules, effects and middleware, not that behaviour is unchanged.

### 4.6.1 Known current limitations (before LSP enrichment)

- `effects[].target` uses the string as-is. `this.storedCats.push` and `this.cats.push` are different fingerprints
  - When a field rename shows up in the targets of effects, `logic` changes
  - Resolution comes with the planned call-resolution / LSP enrichment (see the [roadmap](../roadmap.md)), which introduces type-informed normalization
- The same applies to identifiers inside `rules[].condition` (`if (storedCats.length > 0)` and `if (cats.length > 0)` are different fingerprints)

These are explicitly declared as "not yet guaranteed". A field rename appearing as `logic changed` during review is, today, per spec.

### 4.7 Why the order of locally detected effects is preserved (= not sorted)

By design, the order of effects can carry meaning (transaction boundaries, idempotency, retry safety). Discarding order would give "DB write before event publish" and "event publish before DB write" the same fingerprint, making refactoring-induced bugs undetectable in the diff.

As a trade-off, "unintended reordering" also shows up in the diff, but a miss was judged more costly than noise. A pure reorder pairs every effect with its counterpart, so `delta.effects` holds nothing; `delta.effectsReordered` ([`diff-algorithm.md`](./diff-algorithm.md) §5.2.4) flags it, and the report lists both orders.

The order kept is source order (§4.1), which is the order effects run in only for calls written one after another. A language plugin writes a call before the calls inside it ([lang-plugin.md](./lang-plugin.md) §5.1), so `x.save(y.publish())` hashes as `[x.save, y.publish]` although `y.publish` runs first, and rewriting it as `x.save(); y.publish()` leaves `logic` where it was.

This applies to locally detected effects, each of which sits at a call site in the body. Propagated effects have none: propagation appends them after the local ones in `(id, target)` order ([`effect-propagation.md`](./effect-propagation.md) §8), an order that never followed the sequence in which the callees' side effects run. The fingerprint therefore reads them by target alone (§4.1, §4.5), which loses no ordering this section protects.

### 4.8 A value that names nothing

Of the input fields, `rules[].type` and `rules[].loopKind` classify a construct without saying anything about it; every other field — `condition`, `what`, `expr`, `effects[].target`, `middleware[]` — carries text from the body. A Symbol with no effect and no rule carrying any of those hashes to a value it shares with every body of the same shape: one value for every class and body that only calls something (the empty input), another for every single `try`, another for every route behind `requireAdmin` alone. Such a value is not evidence of one meaning, and the diff does not read it as such ([`diff-algorithm.md`](./diff-algorithm.md) §3.3).

A `value`, a `loop` and a `branch` rule carry text, and change the hash with it, but are not counted as naming something either. A declared value (`true`, `0`, `"admin"`), a loop's header (`const item of items`) and a branch's condition (`enabled`) recur across unrelated declarations, so every `export const ENABLED = true` hashes alike, as does every body that is one `for (const item of items)` loop over calls or one `if (enabled)` around a call; counted, a deleted constant and an unrelated one added elsewhere with the same value would pair as a single move. A Symbol whose only rules are these is read as naming nothing, so the diff pairs it by name alone ([`diff-algorithm.md`](./diff-algorithm.md) §3.3).

For such a Symbol the diff reads its shape rather than its hash (`logicShapeFingerprint` in `@aburi/core`): the logic input with its declared values left out and every other rule's text removed, which keeps the rules' types and loop kinds in order and the middleware. Since the text says nothing here, neither does a change to it: a constant that moves file and changes its value, an enum that gains a member and a branch whose condition changes are still one shape, and still pair by name.

`middleware[]` changes the hash but is not counted as naming something. A guard such as `auth` fronts many routes, so two registrations that agree on it alone say no more about being one route than two bodies that agree on `rules[].type` do; counted, it let a deleted endpoint and an unrelated one added behind the same guard pair as a single move, and `--fail-on removed` never saw the deletion.

`logicNamesNothing` (`@aburi/core`) tells such a Symbol apart, reading the same input the hash is. A field added to the input counts as naming something until it is listed as classifying only.

## 5. `syntax` fingerprint

Represents the **AST structure** of the Symbol: its body, and the parts of its declaration the api axis does not read, a class's head, a function's parameter list and a member's own modifiers ([lang-plugin.md](./lang-plugin.md) LP8p, LP8p1, LP8p2). Changes on any structural change other than formatting.

### 5.1 Input fields

`syntax` computation is the **responsibility of the language plugin**. AST shapes differ per language, so the core cannot define it.

The language plugin generates a **normalized AST string** per Symbol and computes `Symbol.fingerprint.syntax` from it. The normalized AST string satisfies the following conventions:

1. Contains no comment nodes
2. Contains no position information (line, column, byte offset)
3. Contains no whitespace tokens
4. Is an S-expression representing node kinds and child-node structure, plus every unnamed token except the punctuation a formatter adds, drops or swaps without changing the program: string delimiters, an optional `;`, a trailing `,`, a union's or an intersection's leading `|` or `&` (`| A | B` reads as `A | B`, without the extra level the parser gives the leading form), the parentheses around an arrow function's lone parameter (`x => …` reads as `(x) => …`, with the levels the parser gives the parenthesised form), and brackets the structure already implies. Punctuation that is the only record of something is not a formatter's, and stays in: the commas that make a hole in a JavaScript array (`[, x]` against `[x]`). Parentheses the grouping does not need are left out with their level, so `return (\n  <div />\n)` reads as `return <div />` and `(a && b) || c` as `a && b || c`, by the rule a rule's strings follow ([lang-plugin.md](./lang-plugin.md) §4.4), and `new A` reads as `new A()`, with the empty `arguments` level the parser gives the written list
5. Includes identifier and literal values (concrete values, not structure alone): a string as its value, one fragment whatever escapes spell it (`'it\'s'` as `"it's"`), a number in the spelling a rule's strings give it (`1.50` as `1.5`, `0XFF` as `0xff`), a quoted property key, member name or enum member that needs no quotes as the name it spells (`{ "a": 1 }` as `{ a: 1 }`), and the text between JSX tags as React renders it: a run of text read whole with its character references, a line break and the indentation around it dropped, a line holding nothing else left out, and a container holding only spaces (`{" "}`) read as those spaces
6. Contains nothing the parser inserted: a MISSING node, the parser's repair of a broken file, is treated as unwritten
7. Contains what the parser skipped: an ERROR node, the text of a broken file the parser could not place, is serialized with its tokens, including where the parser marks it an extra as it marks a comment. Comments, `<!--` ones included, are the only extras left out. An ERROR that holds no token is a run of characters the parser could not lex, which it merges into one leaf across whitespace and line breaks, so it is serialized as one `(ERROR "…")` per whitespace-separated piece of its text. An ERROR whose every child is left out (string delimiters, `;`, `,`, parentheses, brackets and braces, comments, MISSING nodes) contributes nothing, so a stray `)` changes nothing. A leading `|` or `&` keeps its level when an ERROR that contributes something sits beside it, since reducing the level to its operand would drop the ERROR. An ERROR is read wherever it sits in the parts this string describes, and anywhere else in a function's or a class's head: in a return type or a function's type parameters, which the api axis rebuilds from tokens that leave an extra out, and between the head's parts (`extends A B`, `f() B {}`). The head of a declaration described by its body alone, such as an interface, is read by neither axis, and an ERROR in it is not either

Item 4 is what keeps `a + b` and `a - b` apart. Most parsers hold an operator or a `let` / `const` keyword as an unnamed token rather than a node, so a string built from node kinds alone reads either edit as no change — and because an operator outside a rule's text reaches neither `api` nor `logic`, the Symbol would be reported as unchanged on every axis.

Example (TypeScript): a method as it appears in its class's normalized string. This is not tree-sitter's `node.toString()`: field names are omitted, the text of identifiers and literals is appended as a quoted atom, and every unnamed token outside the formatting punctuation appears as a quoted child in place.

```
(method_definition (property_identifier "createInvoice")
  (formal_parameters (required_parameter (identifier "total") (type_annotation ":" (predefined_type "number"))))
  (statement_block
    (if_statement "if"
      (parenthesized_expression (binary_expression (identifier "total") ">" (number "0")))
      (throw_statement "throw" (new_expression "new" (identifier "Error") (arguments (string (string_fragment "x"))))))))
```

The line breaks are for reading; the string itself separates children with one space.

### 5.2 Formula

```
syntax_input = <normalized AST string generated by the language plugin>
syntax = lower_hex(SHA-256(UTF-8(syntax_input))[0..6])
```

### 5.3 Guaranteed invariance conditions

- Whitespace / newline / indentation changes → unchanged
- Line terminators (LF, CRLF, a lone CR) → unchanged
- Adding / removing comments → unchanged
- The quotes around a string and the escapes they take, a trailing comma, optional semicolons, a union's leading `|` or an intersection's leading `&`, the parentheses around an arrow function's lone parameter → unchanged
- The quotes around a key that needs none, a number's letter case and zeros, parentheses the grouping does not need, `new A` against `new A()`, and JSX children laid out over lines, with the `{" "}` a formatter writes where it breaks them → unchanged

These are what items 4 and 5 leave out or settle, not formatter output in general. A formatter that rewrites JSX (`<Foo></Foo>` → `<Foo />`) changes the structure, and `syntax` changes with it.

Line terminators are held by the core, not by `normalizeAst`, which is why S2d in §7.6 is the core's row rather than a plugin's: the scan reads every source file with CRLF and a lone CR converted to LF before a plugin sees it. The step is needed because the syntax axis does not pass through the canonical-string collapse (§2.2), and item 3 drops whitespace tokens but not a literal's content, so a line break inside a template literal, or inside a string that continues across lines, would otherwise reach `syntax_input` as `\r\n` on one checkout and `\n` on another. `api` and `logic` never needed it, since §2.2 collapses that line break with the rest of the whitespace.

### 5.4 Guaranteed change conditions

- Adding / removing statements → changes
- Renaming an identifier → changes (`syntax` is structure-based, not meaning-based, so identifiers are treated as part of the structure)
- Changing a literal → changes
- Changing an operator, a declaration keyword (`let` / `const`), a modifier or a primitive type → changes
- Changing a function's parameter list where the api axis does not read it — a parameter's name, a destructuring pattern, a default's value, the order of its decorators → changes. The api input reads a parameter's type, form, modifiers and decorators only (§3.1), so the language plugin's normalized string covers the list as well as the body ([lang-plugin.md](./lang-plugin.md) LP8p1). The list goes in whole, so an edit to a parameter's type, form, modifier or decorator changes `syntax` as well as `api`; a return type or a type parameter, outside the list, changes `api` alone
- Changing a member's own modifiers where neither its id nor the api axis reads them — `override`, `?`, `get` / `set`, and on a field holding a function `readonly` and `accessor` → changes, on the member as well as its class ([lang-plugin.md](./lang-plugin.md) LP8p2)

### 5.5 Uses of the syntax fingerprint

The main use is the **three-tier display** in the Diff report:

- `api unchanged, logic unchanged, syntax unchanged` → completely unchanged, not shown in the Diff
- `api unchanged, logic unchanged, syntax changed` → an edit outside what `api` and `logic` read (§4.6): a reformat or a rename inside the body, or an edit neither axis weighs, low-priority
- `api unchanged, logic changed` → semantic change, needs review
- `api changed` → public contract change, needs approval

Symbols with only `syntax changed` are shown collapsed in the Diff report to reduce review load.

### 5.6 Grammar revision dependency (important)

The `syntax` fingerprint **changes wholesale on minor updates of the parser grammar the language plugin adopts**.
tree-sitter grammars routinely rename nodes (`property_identifier` → `member_property`, etc.), so a mere `pnpm update` could turn every Symbol in Aburi `syntax-changed`.

To prevent this:

1. **Language plugins record `grammarRevision` in the IR**:
   A lang plugin declares the exact grammar it parses with in its manifest's `grammarRevision` ([`extension-vocab.md`](./extension-vocab.md) §3.1), and each scan records it in `generator.plugins[type=lang].grammarRevision`.
   **The format is strictly fixed**: `^[\w./@-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$` (e.g. `tree-sitter-typescript@0.23.2`, `@oxc-project/parser@2.1.0+sha.abc123`).
   The manifest schema and the registry validate the format, and the scan refuses a plugin handed to it with a malformed one (`scan-plugin-misconfigured`). This prevents "incomparable" results caused by plugin authors' notation drift.
   `lang-typescript` declares `@vscode/tree-sitter-wasm@<version>`: its build copies the `.wasm` grammars from that package, so the package's release identifies them exactly. A lang plugin that declares none is recorded as `<name>@<version>` with any build metadata dropped (the form takes one suffix), its manifest's `version` standing for its grammar. That holds only while the manifest's `version` changes with every grammar change, so a plugin whose grammar can move without its version should declare `grammarRevision`.

2. **The diff never compares two grammars by accident, and says so when it is handed two**:
   `aburi diff <base>..<head>` scans the base revision and the working tree with the head's plugins ([`cli-spec.md`](./cli-spec.md) §6.4 step 3), so its two IRs share one grammar by construction, and a `pnpm update` that moves the grammar moves the syntax fingerprint of both sides at once: nothing reads as changed for it.
   Two stored IRs (`aburi diff --base <ir> --head <ir>`) can disagree. The CLI compares the `grammarRevision` of each plugin both record by **string equality**, and names a mismatch on its plugin-set warning line, which then says that every Symbol parsed by that plugin can read as a syntax-only change under the other grammar ([`cli-spec.md`](./cli-spec.md) §6.6, CL62).
   The diff itself reports what the two documents say ([`diff-algorithm.md`](./diff-algorithm.md) §11.8): it does not discount the syntax differences, and `diff.json` records nothing of the mismatch. A grammar wave lands mostly in the report's folded Syntax-only section (a moved Symbol reads as `moved+changed`, and a Slice still lists its members as syntax only); a gate on `changed` still counts it, which is why the line tells the caller to rescan both sides with one plugin set or diff the two revisions. The api/logic fingerprints are reported as usual.

3. **The grammar is pinned by the plugin's own release**:
   `lang-typescript` vendors its grammars at build time from a devDependency, so an installed release always parses with the grammar it was built with, and moves to another only with a new release of the plugin. A plugin that loads a grammar package the user installs instead pins the version it supports in peerDependencies, so an inconsistent install is detectable at install time.

The `api` / `logic` fingerprints are defined by plugin-independent computation conventions (§3, §4) and are therefore unaffected by grammar versions. Only `syntax` is subject to this consideration.

## 6. Dropped symbols

Symbols with `Symbol.dropped == true` use a fixed value on all three fingerprint axes:

```jsonc
{
  "api":    "000000000000",
  "logic":  "000000000000",
  "syntax": "000000000000"
}
```

As a result, comparing dropped symbols against each other always yields "no change", and they are excluded from the Diff report.

## 7. Verifiable properties (test criteria)

The reference implementation and every language plugin must pass the following tests.

### 7.1 Identity

| ID | Input | Expected |
|---|---|---|
| T1 | Compute the same Symbol twice | api/logic/syntax all match |
| T2 | Canonical-serialize the Symbol → parse → recalculate | match |

### 7.2 api invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| A1 | Change `signature.inputs[].name` | api unchanged |
| A2 | Change the body (rules/effects) | api unchanged |
| A3 | Reorder decorators (distinct decorators), a Symbol's or a parameter's | api unchanged; a parameter's reorder changes syntax (§5.4) |
| A12 | Change only the class-scope portion of `Symbol.name` (`Old.method` → `New.method`) | api unchanged |
| A13 | Change `language` (never happens in practice; defensive) | api unchanged (`language` is not part of the input) |
| A22 | Change `signature.inputs[].name` from `ids` to `...ids` | api unchanged (A1's case: rest-ness is `rest`, and a marker spelled into `name` reaches no axis) |
| A23 | Change only the value of a parameter's default (`limit = 10` → `limit = 20`) | `signature.inputs` and api unchanged (the IR records that a default exists, as `optional`, and not its value); syntax changes (S5b) |
| A24 | Join a parameter type broken over lines onto one line: `\| ClassProvider \| FactoryProvider` → `ClassProvider \| FactoryProvider`, `Array<` … `\| A` … `\| B` … `>` → `Array<A \| B>`, `(` … `request: Request,` … `) => void` → `(request: Request) => void`; or swap the quotes of a string literal type, `'fast' \| 'slow'` → `"fast" \| "slow"` | api unchanged (LP11e records each spelling as the one-line text) |
| A25 | Export a declaration under its own name by a clause instead of the keyword, or reorder the names a clause exports it under | api unchanged (§3.8) |
| A28 | Break a decorator's arguments over lines, write a comment inside them or swap their quotes, on a parameter, a method or a class: `@Inject(` … `TOKEN,` … `)` → `@Inject(TOKEN)`, `@Inject(/* legacy */ TOKEN)` → `@Inject(TOKEN)`, `@Controller('users')` → `@Controller("users")` | api unchanged (LP11f and LP14 record each spelling as the one-line text) |
| A29 | Rename a parameter, a `catch` binding or a local the Symbol throws (`catch (e) { throw e }` → `catch (error) { throw error }`) | api unchanged (LP13b records no name the Symbol binds) |

### 7.3 api change conditions

| ID | Mutation | Expected |
|---|---|---|
| A4 | Change `visibility` | api changes |
| A5 | Add a type to `signature.outputs` | api changes |
| A6 | Add a type to `signature.throws` | api changes |
| A7 | Add a decorator | api changes |
| A8 | Change decorator arguments (`@Post('/x')` → `@Post('/y')`) | api changes |
| A9 | `async` true ↔ false | api changes |
| A10 | Change `kind` (`function` → `method`, etc.) | api changes |
| A11 | Change `extKind` | api changes |
| A14 | Change `shortName` (last segment) | api changes |
| A20 | Toggle `signature.inputs[].optional` (absent ↔ `true`) | api changes |
| A21 | Toggle `signature.inputs[].rest` (absent ↔ `true`) | api changes |
| A26 | Change the names a module exports a declaration under (`export { handler as GET }` → `export { handler as DELETE }`, `export default function Page` → `export function Page`) | api changes (§3.8) |
| A27 | Change a parameter property's modifier (`private s` → `public s`, `readonly` dropped) or a parameter's decorator (`@Inject(A)` → `@Inject(B)`, `@Param("id")` → `@Param("key")`) | api changes on the member the parameter belongs to |

### 7.4 logic invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| L1 | Rename a local variable that does not appear in rules/effects strings | logic unchanged |
| L2 | Add a comment (§4.3) | logic unchanged |
| L3 | Lengthen, shorten or re-wrap a run of whitespace, or write or leave out a space between two tokens (§4.3) | logic unchanged |
| L3a | Run a formatter over a rule's expression: swap the quotes of a string and the escapes they take (`'it\'s'` → `"it's"`), unquote a key, add a trailing comma, parenthesize an arrow's lone parameter, drop the semicolons ending statements, in a block or not, write `new E` as `new E()`, wrap JSX laid out over lines in parentheses and break it with `{" "}`, parenthesize mixed `&&` and `\|\|`, rewrite `1.50` as `1.5` (§4.3) | logic unchanged |
| L4 | Add a decoration (`console.log`, etc.) | logic unchanged |
| L5 | Change a decorator | logic unchanged |
| L11 | Change only the effect's `id` (same target) — plugin configuration robustness | logic unchanged |
| L12 | Adding/removing/reordering effect plugins classifies the same target under a different id | logic unchanged |
| L12a | L11/L12 on a callee's effect that reaches a caller as one of two propagated effects, where the id change flips the two entries' `(id, target)` order; the caller is compared, with or without a locally detected effect of its own | logic unchanged |
| L12b | L11/L12 unifies the ids under which two callees classify one target, which reached a caller as two propagated effects on that target and now reaches it as one; the caller is compared | logic unchanged |
| L12c | L11/L12 unifies a callee's id for a target with the id of the caller's own locally detected effect on that target, so propagation now drops the propagated entry it kept before; the caller is compared | logic unchanged |
| L12d | A Symbol with no `middleware`, compared with the value it hashed to before the field existed | logic unchanged |

### 7.5 logic change conditions

| ID | Mutation | Expected |
|---|---|---|
| L6 | Reorder rules | logic changes |
| L7 | Reorder locally detected effects, including two written one after another on one line | logic changes |
| L8 | Change a rule's condition | logic changes |
| L8a | Change the condition of an `if` that does not leave early, a loop's header, a `case` label, a constant's initializer, an entry of an object a constant holds, or an enum member's value; add or remove an enum member | logic changes |
| L9 | Change an effect's target | logic changes |
| L10 | Add / remove an effect, locally detected or propagated (a propagated one on a target no other effect of the Symbol names) | logic changes |
| L10a | Add, remove, reorder or rename an entry of `middleware` | logic changes |

### 7.6 syntax invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| S1 | Add a comment | syntax unchanged |
| S2 | Change whitespace formatting | syntax unchanged |
| S2a | Change the quotes around a string that needs no escape either way | syntax unchanged |
| S2b | Add a trailing comma | syntax unchanged |
| S2c | Drop optional semicolons | syntax unchanged |
| S2d | Save the file with CRLF or a lone CR | syntax unchanged — guaranteed by the core's scan, not by `normalizeAst` (§5.3) |
| S2e | Join a union broken over lines onto one line, dropping its leading `\|` (`\| A` … `\| B` → `A \| B`), or an intersection, dropping its leading `&`, in a type alias, a parameter, a method's parameter or an overload | syntax unchanged |
| S2f | Put an arrow function's lone parameter in parentheses (`x => …` → `(x) => …`), wherever the arrow is written: a const, a class field, an object entry, a call's argument, a body | syntax unchanged |
| S2g | Lay JSX children out over lines, breaking them with `{" "}`, and wrap the element in parentheses, unquote a key that needs no quotes, swap a string's quotes and the escapes they take, drop parentheses the grouping does not need, write `new A` as `new A()`, or rewrite a number's case and zeros (`0XFF` → `0xff`) | syntax unchanged |

### 7.7 syntax change conditions

| ID | Mutation | Expected |
|---|---|---|
| S3 | Add a statement | syntax changes |
| S4 | Rename an identifier | syntax changes |
| S5 | Change a literal | syntax changes |
| S5a | Change an operator, a declaration keyword, a modifier or a primitive type (`a + b` → `a - b`, `let` → `const`, `private` → `public`, `number` → `string`) | syntax changes |
| S5b | Change a destructuring parameter's pattern (`{ a: b }` → `{ c: b }`, `[, b]` → `[b]`) or a parameter's default value (`limit = 20` → `limit = 10`) | syntax changes; api unchanged (A1, A23) |
| S5c | In a file with a syntax error, change the text the parser could not place (`type T = \| A B` → `\| X B`, `save(a b)` → `save(a c)`, `f(): Map<A B, C>` → `Map<A X, C>`, `class K extends A B` → `extends A X`) | syntax changes; a comment added there, a stray `)` or the spacing inside a run the parser could not lex (`# #` → `#   #`) does not (§5.1 item 7) |
| S5d | Add `override` to a method or an accessor, make it optional (`m()` → `m?()`), turn it into a getter (`m()` → `get m()`), or add `readonly` / `override` / `accessor` / `?` to a field holding a function | syntax changes on the member as well as its class; api unchanged |

### 7.7.1 syntax test criteria every language plugin must satisfy

Every row of §7.6 and §7.7 except S2d, which the core's scan holds (§5.3), falls under the responsibility of each language plugin's `normalizeAst()` implementation, but **the core cannot test the contract itself**, so every plugin must ship the following test harness:

```js
// must be included in the language plugin's test suite
describe('normalizeAst syntax fingerprint contract', () => {
  test('S1: adding a comment leaves syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { /* note */ return 1 }'));
    expect(a).toBe(b);
  });
  test('S2: whitespace formatting change leaves syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f(){return 1}'));
    const b = normalizeAst(parseSnippet('function f() {\n  return 1\n}'));
    expect(a).toBe(b);
  });
  test('S2a: the quotes around a string leave syntax unchanged', () => {
    const a = normalizeAst(parseSnippet("function f() { save('x') }"));
    const b = normalizeAst(parseSnippet('function f() { save("x") }'));
    expect(a).toBe(b);
  });
  test('S2b: a trailing comma leaves syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f() { save(a, b) }'));
    const b = normalizeAst(parseSnippet('function f() { save(a, b,) }'));
    expect(a).toBe(b);
  });
  test('S2c: optional semicolons leave syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f() { save(a); save(b); }'));
    const b = normalizeAst(parseSnippet('function f() {\n  save(a)\n  save(b)\n}'));
    expect(a).toBe(b);
  });
  test('S3: adding a statement changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { const x = 0; return 1 }'));
    expect(a).not.toBe(b);
  });
  test('S4: renaming an identifier changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return x }'));
    const b = normalizeAst(parseSnippet('function f() { return y }'));
    expect(a).not.toBe(b);
  });
  test('S5: changing a literal changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { return 2 }'));
    expect(a).not.toBe(b);
  });
  test('S5a: changing an operator changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { save(a + b) }'));
    const b = normalizeAst(parseSnippet('function f() { save(a - b) }'));
    expect(a).not.toBe(b);
  });
});
```

Plugins that do not satisfy this cannot be registered in the official Aburi plugin registry. It is recommended for third-party plugins as well.

### 7.8 Dropped

| ID | Input | Expected |
|---|---|---|
| D1 | Symbol with `dropped: true` | all fingerprints are `"000000000000"` |
| D2 | Same AST treated differently under `dropped: true` / `false` | former is zero, latter is computed normally |

## 8. Cross-implementation compatibility

Prerequisites for different language plugin implementations to produce identical results:

- `api` / `logic` computation is fully defined in §3 and §4 of this document and is therefore reproducible independently of plugins
- `syntax` computation is language-specific (see §5.1). It is reproducible within a given version of the same language plugin
- If a plugin version upgrade changes the AST extraction rules, `syntax` may change destructively
  - `api` / `logic` may also change for the same Symbol (because extraction granularity changes)
  - This is the trade-off of upgrading to a newer language plugin version

## 9. Reference implementation points

Pseudocode for the JavaScript/TypeScript implementation:

```js
import { createHash } from 'node:crypto'

export function lastSegment(qname) {
  // §3.3 — "::" takes priority, then "."
  const byColon = qname.split('::')
  const tail = byColon[byColon.length - 1]
  const byDot = tail.split('.')
  return byDot[byDot.length - 1]
}

export function apiFingerprint(sym) {
  const decorators = [...sym.decorators].sort((a, b) => {
    // by UTF-16 code unit (`<`), not localeCompare
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return a.line - b.line
  }).map(d => ({ name: d.name, raw: canonical(d.raw), boundary: d.boundary }))

  const signature = sym.signature ? {
    async: sym.signature.async,
    generator: sym.signature.generator,
    inputs: sym.signature.inputs.map(i => ({
      type: canonical(i.type),
      ...(i.optional === true ? { optional: true } : {}),  // §3.1: only when true
      ...(i.rest === true ? { rest: true } : {}),
      ...(i.modifiers?.length > 0 ? { modifiers: [...i.modifiers] } : {}),  // §3.1: only when non-empty
      ...(i.decorators?.length > 0 ? { decorators: i.decorators.map(canonical).sort() } : {})
    })),
    outputs: sym.signature.outputs.map(canonical),
    throws: [...sym.signature.throws].map(canonical).sort(),
    typeParameters: sym.signature.typeParameters.map(canonical)
  } : null

  // §3.8: every name the module exports sym under, unless it is sym's own name alone
  const exportedAs = [...new Set(sym.derivedBy.flatMap(token => exportName(sym, token)))].sort()
  const ownName = sym.name === '<default>' ? 'default' : sym.name
  const ownOnly = exportedAs.length === 0 || (exportedAs.length === 1 && exportedAs[0] === ownName)

  return hash({
    decorators,
    ...(ownOnly ? {} : { exportedAs }),
    extKind: sym.extKind,
    kind: sym.kind,
    shortName: lastSegment(sym.name),   // §3.3
    signature,
    visibility: sym.visibility
    // language excluded: already separated by the <language>: prefix of Symbol.id
  })
}

function exportName(sym, token) {
  if (token === 'export-keyword') return [sym.name]
  if (token === 'export-default') return ['default']
  return token.startsWith('export-clause:') ? [token.slice('export-clause:'.length)] : []
}

export function logicFingerprint(sym) {
  const middleware = sym.middleware ?? []
  return hash({
    effects: logicEffects(sym.effects),  // id excluded (§4.5)
    // left out rather than [] when there is none; as the IR holds it, order kept
    ...(middleware.length > 0 ? { middleware: [...middleware] } : {}),
    rules: sym.rules.map(r => ({
      condition: r.condition !== null ? canonical(r.condition) : null,
      expr:      r.expr !== null ? canonical(r.expr) : null,
      loopKind:  r.loopKind,
      type:      r.type,
      what:      r.what !== null ? canonical(r.what) : null
    }))
  })
}

function logicEffects(effects) {
  // §4.1 segment 1: locally detected effects in call order (§4.7), repeats kept
  const local = effects.filter(e => e.propagated !== true).map(e => canonical(e.target))
  // §4.1 segment 2: propagated targets, each once, none segment 1 holds, sorted by UTF-16
  // code unit (`<`, not localeCompare) rather than in the IR's (id, target) order (§4.5)
  const propagated = [...new Set(effects.filter(e => e.propagated === true).map(e => canonical(e.target)))]
    .filter(t => !local.includes(t))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return [...local, ...propagated].map(target => ({ target }))
}

function canonical(s) {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

function hash(obj) {
  const json = canonicalJson(obj)
  return createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 12)
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
```
