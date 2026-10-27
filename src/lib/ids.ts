/**
 * A uuid, as Postgres accepts one. A page handed an id from its address checks it first: a
 * malformed one (a link wrapped by an email client, a hand-edited address) makes Postgres
 * refuse the query, and since reads now fail loudly (must), that showed the error screen
 * where "not found" is the honest answer.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A calendar date, `YYYY-MM-DD`, that Postgres will accept. The shape alone is not enough:
 * `2026-13-45` and `2026-02-30` both match it, Postgres refuses them (22008), and
 * `Date.parse` quietly rolls the second over to March, so the date is rebuilt and compared.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
