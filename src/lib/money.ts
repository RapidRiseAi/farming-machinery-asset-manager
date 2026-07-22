/** Format integer cents (ex-VAT, Scope §6) as Rands, e.g. 357500 → "R3,575.00". */
export function rands(cents: number | null | undefined): string {
  const v = (cents ?? 0) / 100;
  return (
    "R" +
    v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/**
 * Parse a user-typed Rand amount to integer cents — WITHOUT float drift.
 * Accepts thousands separators and an optional decimal part ("1,150.5" → 115050).
 * Returns null for blank/invalid input.
 */
export function parseRandsToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  const cleaned = String(input).trim().replace(/[\s,]/g, "");
  if (cleaned === "") return null;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === "." || cleaned === "-") return null;
  const neg = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace(/^-/, "").split(".");
  const cents = Number.parseInt(whole || "0", 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  if (!Number.isFinite(cents)) return null;
  return neg ? -cents : cents;
}

/**
 * Convert a VAT-inclusive cents amount to the stored ex-VAT cents (Scope §4.8,
 * money stored ex-VAT). `rateBps` is the VAT rate in basis points (1500 = 15%).
 * Integer math only — rounds to the nearest cent.
 */
export function exVatCents(inclCents: number, rateBps: number): number {
  if (rateBps <= 0) return inclCents;
  return Math.round((inclCents * 10000) / (10000 + rateBps));
}

/** The VAT portion of a VAT-inclusive amount (inclusive − ex-VAT), in cents. */
export function vatOfInclCents(inclCents: number, rateBps: number): number {
  return inclCents - exVatCents(inclCents, rateBps);
}

/** VAT added on top of an ex-VAT amount, in cents. */
export function vatOnExCents(exCents: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  return Math.round((exCents * rateBps) / 10000);
}
