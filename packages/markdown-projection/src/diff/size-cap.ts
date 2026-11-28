import { renderDocument } from "../format"

export interface Section {
  readonly title: string
  readonly lines: readonly string[]
  readonly short?: readonly string[]
  /** The rows of the names-only form, which a section too long for it lists as many of as fit. */
  readonly names?: { readonly heading: string; readonly rows: readonly string[] }
}

export type Shown =
  | { readonly kind: "full" }
  | { readonly kind: "short"; readonly lines: readonly string[] }
  | { readonly kind: "cut"; readonly lines: readonly string[] }
  | { readonly kind: "omitted" }

export type Arrangement = ReadonlyArray<{ readonly section: Section; readonly shown: Shown }>

const FULL: Shown = { kind: "full" }
const OMITTED: Shown = { kind: "omitted" }

const NAMES_ONLY_LINE =
  "_Names and locations only: the full entries did not fit within the size cap._"

export function plainSection(
  heading: string,
  body: readonly string[],
  namesOnly?: readonly string[],
): Section | null {
  if (body.length === 0) return null
  const lines = [heading, "", ...body, ""]
  const short =
    namesOnly === undefined ? undefined : [heading, "", NAMES_ONLY_LINE, "", ...namesOnly, ""]
  return {
    title: titleOf(heading),
    lines,
    ...(short === undefined || byteLength(short) >= byteLength(lines) ? {} : { short }),
    ...(namesOnly === undefined ? {} : { names: { heading, rows: namesOnly } }),
  }
}

function cutLines(names: NonNullable<Section["names"]>, count: number): string[] {
  const { heading, rows } = names
  return [
    heading,
    "",
    `_Names and locations of the first ${count} of ${rows.length} entries: the rest did not fit within the size cap._`,
    "",
    ...rows.slice(0, count),
    `- … and ${rows.length - count} more`,
    "",
  ]
}

export function foldedSection(
  heading: string,
  body: readonly string[],
  summary: string,
): Section | null {
  if (body.length === 0) return null
  return {
    title: titleOf(heading),
    lines: [
      heading,
      "",
      "<details>",
      `<summary>${summary}</summary>`,
      "",
      ...body,
      "",
      "</details>",
      "",
    ],
  }
}

function titleOf(heading: string): string {
  return heading.replace(/^#+ */, "")
}

function byteLength(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join("\n"), "utf8")
}

export function assemble(
  heading: readonly string[],
  sections: readonly Section[],
  maxBytes: number | undefined,
  fullReportLocation: string | undefined,
): string {
  if (maxBytes === undefined) {
    return renderDocument([...heading, ...sections.flatMap((section) => [...section.lines])])
  }

  const render = (arrangement: Arrangement, unachievable: boolean): string =>
    renderDocument([
      ...heading,
      ...omissionNote(arrangement, maxBytes, unachievable, fullReportLocation),
      ...arrangement.flatMap(({ section, shown }) => linesIn(section, shown)),
    ])
  const size = (arrangement: Arrangement): number =>
    Buffer.byteLength(render(arrangement, false), "utf8")

  const whole = sections.map((section) => ({ section, shown: FULL }))
  if (size(whole) <= maxBytes) return render(whole, false)
  const arrangement = arrangeWithin(sections, size, maxBytes)
  if (size(arrangement) <= maxBytes) return render(cutIntoRoom(arrangement, size, maxBytes), false)
  return render(
    sections.map((section) => ({ section, shown: OMITTED })),
    true,
  )
}

type Row = { readonly section: Section; shown: Shown }

/** Sizes are the whole document's, note included: naming a section there costs bytes too. */
export function arrangeWithin(
  sections: readonly Section[],
  size: (arrangement: Arrangement) => number,
  maxBytes: number,
): Arrangement {
  const rows = sections.map((section): Row => ({ section, shown: OMITTED }))
  const formsShown = (): Shown[] => rows.map(({ shown }) => shown)
  const showAs = (forms: readonly Shown[]): void => {
    for (const [index, row] of rows.entries()) row.shown = forms[index] ?? OMITTED
  }
  const place = (row: Row, index: number): void => {
    const before = formsShown()
    let best: { forms: Shown[]; bytes: number } | null = null
    for (const shown of formsOf(row.section)) {
      row.shown = shown
      const bytes = size(rows)
      if (best === null || bytes < best.bytes) {
        const ordered = orderBelow(rows, index, size, bytes)
        if (ordered !== null && ordered <= maxBytes) {
          best = { forms: formsShown(), bytes }
        }
      }
      showAs(before)
    }
    showAs(best?.forms ?? before)
  }
  const wholeFromTop = (): void => {
    for (const row of rows) {
      const shown = row.shown
      if (shown.kind !== "short") continue
      row.shown = FULL
      if (size(rows) > maxBytes) {
        row.shown = shown
        return
      }
    }
  }

  for (const [index, row] of rows.entries()) place(row, index)
  // A section placed or made whole later leaves the note, which can free room for one omitted
  // earlier. A section once shown is never omitted again, so the loop ends.
  for (let putBack = true; putBack; ) {
    wholeFromTop()
    putBack = false
    for (const [index, row] of rows.entries()) {
      if (row.shown.kind !== "omitted") continue
      place(row, index)
      if (row.shown.kind !== "omitted") putBack = true
    }
  }
  return rows
}

/**
 * Runs after the passes, so the sections they placed keep their forms and a cut takes only room
 * nothing more important could use. Each list cut leaves the rest of the room to the ones below.
 */
export function cutIntoRoom(
  arrangement: Arrangement,
  size: (arrangement: Arrangement) => number,
  maxBytes: number,
): Arrangement {
  let current = arrangement
  for (const [index, { section, shown }] of arrangement.entries()) {
    if (shown.kind !== "omitted" || section.names === undefined) continue
    current = cutAt(current, index, section.names, size, maxBytes)
  }
  return current
}

function cutAt(
  arrangement: Arrangement,
  index: number,
  names: NonNullable<Section["names"]>,
  size: (arrangement: Arrangement) => number,
  maxBytes: number,
): Arrangement {
  const cutTo = (count: number): Arrangement =>
    arrangement.map((row, at) =>
      at === index
        ? { section: row.section, shown: { kind: "cut", lines: cutLines(names, count) } }
        : row,
    )
  // Every name fitting would be the names-only form, which the passes already tried.
  let fits = 0
  let fitsNot = names.rows.length
  while (fitsNot - fits > 1) {
    const count = Math.floor((fits + fitsNot) / 2)
    if (size(cutTo(count)) <= maxBytes) fits = count
    else fitsNot = count
  }
  return fits === 0 ? arrangement : cutTo(fits)
}

/** Whole first, so that a tie keeps the section whole. */
function formsOf(section: Section): Shown[] {
  return section.short === undefined ? [FULL] : [FULL, { kind: "short", lines: section.short }]
}

/** A less important list gives way rather than cost the section at `index` its place. */
function orderBelow(
  rows: readonly Row[],
  index: number,
  size: (arrangement: Arrangement) => number,
  bytes: number,
): number | null {
  let current = bytes
  for (;;) {
    const next = firstOutOfOrder(rows, size, current)
    if (next === null) return current
    if (next.index <= index) return null
    next.row.shown = next.short
    current = next.bytes
  }
}

/** On a tie a list stays whole below a names-only one: whole shows more for the same bytes. */
function firstOutOfOrder(
  rows: readonly Row[],
  size: (arrangement: Arrangement) => number,
  bytes: number,
): { index: number; row: Row; short: Shown; bytes: number } | null {
  let shortAbove = false
  for (const [index, row] of rows.entries()) {
    const { section, shown } = row
    if (section.short === undefined) continue
    if (shown.kind === "short") shortAbove = true
    if (shown.kind !== "full" || !shortAbove) continue
    const short: Shown = { kind: "short", lines: section.short }
    row.shown = short
    const shorter = size(rows)
    row.shown = shown
    if (shorter < bytes) return { index, row, short, bytes: shorter }
  }
  return null
}

function linesIn(section: Section, shown: Shown): readonly string[] {
  switch (shown.kind) {
    case "full":
      return section.lines
    case "short":
    case "cut":
      return shown.lines
    case "omitted":
      return []
  }
}

function omissionNote(
  arrangement: Arrangement,
  maxBytes: number,
  unachievable: boolean,
  fullReportLocation: string | undefined,
): string[] {
  const titlesShown = (kind: Shown["kind"]) =>
    arrangement.filter(({ shown }) => shown.kind === kind).map(({ section }) => section.title)
  const groups = [
    { label: "Names only", titles: titlesShown("short"), claim: "names only", passive: false },
    { label: "Cut short", titles: titlesShown("cut"), claim: "cut short", passive: true },
    { label: "Omitted", titles: titlesShown("omitted"), claim: "omitted", passive: true },
  ].filter(({ titles }) => titles.length > 0)
  if (groups.length === 0) {
    return unachievable
      ? [`> ⚠ This report could not be brought within ${maxBytes} bytes.`, ""]
      : []
  }
  const budget = unachievable
    ? `and this report still could not be brought within ${maxBytes} bytes`
    : `to keep this report within ${maxBytes} bytes`
  const pointer =
    fullReportLocation === undefined
      ? "The full report is the same diff rendered without a size cap."
      : `The full report, the same diff without a size cap, is ${fullReportLocation}.`
  const claimOf = ({ claim, passive, titles }: (typeof groups)[number]): string =>
    `**${countSections(titles.length, passive)} ${claim}**`
  const [only] = groups
  if (only !== undefined && groups.length === 1) {
    return [`> ⚠ ${claimOf(only)} ${budget}: ${only.titles.join(", ")}. ${pointer}`, ""]
  }
  const claims = joinWithAnd(groups.map(claimOf))
  const lists = groups.map(({ label, titles }) => `${label}: ${titles.join(", ")}.`).join(" ")
  return [`> ⚠ ${claims} ${budget}. ${lists} ${pointer}`, ""]
}

function countSections(count: number, passive = false): string {
  if (passive) return count === 1 ? "1 section was" : `${count} sections were`
  return count === 1 ? "1 section lists" : `${count} sections list`
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(" and ")
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}
