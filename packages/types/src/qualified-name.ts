/**
 * The api fingerprint, the diff's name matchers and the report's name-row check all read a Symbol's
 * short name here, so none of them can disagree on it.
 */
export function lastSegment(name: string): string {
  // Scanned forward, so a name holding `:::` keeps the reading `split("::")` gives it, without the
  // arrays a split allocates on a path the matchers take for every candidate pair.
  let last = -2
  for (let at = name.indexOf("::"); at !== -1; at = name.indexOf("::", at + 2)) last = at
  const tail = name.slice(last + 2)
  return tail.slice(tail.lastIndexOf(".") + 1)
}
