import { CliError, type CliErrorCode } from "./errors"

export type ThreadThrown =
  | {
      kind: "cli"
      message: string
      code: CliErrorCode
      stack: string | undefined
      cause: ThreadThrown | undefined
    }
  | {
      kind: "error"
      name: string
      message: string
      stack: string | undefined
      code: unknown
      cause: ThreadThrown | undefined
    }
  | { kind: "value"; text: string }

/**
 * What a thread sends of an error and its causes: a structured clone drops a class it does not
 * know, and with it the name and the fields it adds, `code` among them.
 */
export function describedForThread(error: unknown): ThreadThrown {
  return describedOnce(error, new Set())
}

function describedOnce(error: unknown, described: Set<unknown>): ThreadThrown {
  described.add(error)
  if (!(error instanceof Error)) return { kind: "value", text: String(error) }
  // A cause already described closes a cycle, which the trace ends at anyway.
  const cause =
    error.cause === undefined || described.has(error.cause)
      ? undefined
      : describedOnce(error.cause, described)
  if (error instanceof CliError) {
    return { kind: "cli", message: error.message, code: error.code, stack: error.stack, cause }
  }
  return {
    kind: "error",
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: ifCloneable((error as { code?: unknown }).code),
    cause,
  }
}

export function ifCloneable(value: unknown): unknown {
  try {
    structuredClone(value)
    return value
  } catch {
    return undefined
  }
}

export function rebuiltFromThread(thrown: ThreadThrown): unknown {
  switch (thrown.kind) {
    case "cli":
      return withStack(
        new CliError(thrown.message, thrown.code, causeOf(thrown.cause)),
        thrown.stack,
      )
    case "error": {
      const error = withStack(new Error(thrown.message, causeOf(thrown.cause)), thrown.stack)
      error.name = thrown.name
      if (thrown.code !== undefined) Object.assign(error, { code: thrown.code })
      return error
    }
    case "value":
      return thrown.text
  }
}

function causeOf(cause: ThreadThrown | undefined): { cause: unknown } | undefined {
  return cause === undefined ? undefined : { cause: rebuiltFromThread(cause) }
}

function withStack<T extends Error>(error: T, stack: string | undefined): T {
  if (stack !== undefined) error.stack = stack
  return error
}
