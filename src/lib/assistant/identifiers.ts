import { z } from "zod";

// PostgreSQL's uuid type accepts the canonical 8-4-4-4-12 hexadecimal shape
// without requiring an RFC version or variant nibble. Demo and long-lived rows
// may therefore use deterministic identifiers that are not RFC 9562 UUIDs.
const POSTGRES_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const postgresUuidSchema = z.string().regex(POSTGRES_UUID_PATTERN);

export function isPostgresUuid(value: string): boolean {
  return postgresUuidSchema.safeParse(value).success;
}

export function isSafeAssistantMachineHref(href: string): boolean {
  const prefix = "/machines/";
  if (!href.startsWith(prefix)) return false;

  const machineId = href.slice(prefix.length);
  return isPostgresUuid(machineId);
}
