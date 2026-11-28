// Node's own reading, so that aburi and the Node tools beside it in a pipeline agree.
const FORCE_COLOR_ON: ReadonlySet<string> = new Set(["", "1", "true", "2", "3"])

export function readForceColor(value: string | undefined): boolean | null {
  if (value === undefined) return null
  return FORCE_COLOR_ON.has(value)
}
