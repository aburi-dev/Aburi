import { identifierMentions, receiverConfidence } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, Confidence } from "@aburi/types"

const DRIZZLE_CLIENT_WORDS_LIST = [
  "drizzle",
  "db",
  "database",
  "conn",
  "connection",
  "orm",
  "tx",
  "trx",
] as const

export type DrizzleClientWord = (typeof DRIZZLE_CLIENT_WORDS_LIST)[number]

export const DRIZZLE_CLIENT_WORDS: ReadonlySet<DrizzleClientWord> = new Set(
  DRIZZLE_CLIENT_WORDS_LIST,
)

export function namesDrizzleClient(segment: string): boolean {
  return identifierMentions(segment, DRIZZLE_CLIENT_WORDS as ReadonlySet<string>)
}

// Another ORM's client words too, since it is that ORM's `<client>.<model>.<verb>` the delegate
// gate keeps out.
const ORM_CLIENT_WORDS: ReadonlySet<string> = new Set([...DRIZZLE_CLIENT_WORDS_LIST, "prisma"])

export function namesOrmClient(segment: string): boolean {
  return identifierMentions(segment, ORM_CLIENT_WORDS)
}

export function classificationConfidence(
  clientSegment: string | undefined,
  call: CallCandidate,
  maxArguments: number,
): Confidence {
  return receiverConfidence(clientSegment, call, maxArguments, namesDrizzleClient)
}
