/** Format integer cents (ex-VAT, Scope §6) as Rands, e.g. 357500 → "R3,575.00". */
export function rands(cents: number | null | undefined): string {
  const v = (cents ?? 0) / 100;
  return (
    "R" +
    v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}
