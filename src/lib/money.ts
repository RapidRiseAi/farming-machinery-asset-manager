/**
 * Format integer cents as Rands: 357500 → "R3 575,00".
 *
 * Formatted BY HAND rather than through `toLocaleString("en-ZA")`, because that function
 * does not give the same answer everywhere. Measured in this project's own environment:
 *
 *     Node    (2242.5).toLocaleString("en-ZA")  →  "2 242,50"
 *     Chrome  (2242.5).toLocaleString("en-ZA")  →  "2,242.50"
 *
 * A runtime with trimmed ICU data silently falls back to en-US, and a runtime's locale
 * tables are not something this app controls. That produced two real problems at once:
 * the same invoice read differently depending on which side rendered it, and any CLIENT
 * component showing an amount that the server had already rendered hydrated with
 * different text, a React #418 text mismatch, which makes React throw the server HTML
 * away and re-render the whole subtree in the browser. That is exactly the failure the
 * machines list hit earlier for a different reason.
 *
 * Money in a single-currency product has one correct rendering, so it is written out
 * directly: a non-breaking space between thousands (SA convention, and it stops an amount
 * wrapping mid-number), a comma before the cents, always two decimals.
 */
const THIN_GAP = " ";

export function rands(cents: number | null | undefined): string {
  const c = Math.round(cents ?? 0);
  const negative = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const part = String(abs % 100).padStart(2, "0");

  // Group from the right in threes without a regex lookbehind, Safari on older iOS
  // does not support them, and this is rendered on every screen in the product.
  const digits = String(whole);
  let grouped = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += THIN_GAP;
    grouped += digits[i];
  }

  return `${negative ? "-" : ""}R${grouped},${part}`;
}

/**
 * Parse a user-typed Rand amount to integer cents, WITHOUT float drift.
 * Accepts "R", thousands separators and a decimal point or comma ("1,150.5" → 115050,
 * "1 150,50" → 115050, "250,00" → 25000). Returns null for blank, invalid or ambiguous input.
 */
export function parseRandsToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  // "R250", spaces (also the non-breaking kinds a phone keyboard or a paste brings) and
  // apostrophes group thousands and are dropped.
  let cleaned = String(input).trim().replace(/^R\s*/i, "").replace(/[\s  ']/g, "");
  // A decimal comma is how South Africans write money ("250,00", "1 500,50"): it must
  // never be read as a thousands separator, which made "250,00" R25 000. With both marks
  // ("1,500.50", "1.500,50") the last one is the decimal; a lone comma is the decimal
  // when one or two digits follow it, and groups thousands only in threes ("1,500");
  // anything else ("1,2345") is ambiguous and refused. A dot alone is the decimal, as before.
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    cleaned = lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (lastComma !== -1) {
    const digits = cleaned.replace(/^-/, "");
    if (/^\d*,\d{1,2}$/.test(digits)) cleaned = cleaned.replace(",", ".");
    else if (/^\d{1,3}(,\d{3})+$/.test(digits)) cleaned = cleaned.replace(/,/g, "");
    else return null;
  }
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
 * Integer math only, rounds to the nearest cent.
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
