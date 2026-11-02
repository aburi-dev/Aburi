import { lt } from "drizzle-orm"
import type { Database } from "../db/drizzle"
import { auditLog } from "../db/schema"

export async function expiredEntries(gateway: Database, before: Date) {
  return await gateway.select().from(auditLog).where(lt(auditLog.at, before))
}
